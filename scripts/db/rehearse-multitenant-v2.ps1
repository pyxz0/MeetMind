# 兼容 Windows PowerShell 5.1（本机只装了 5.1，不要用 7 的语法）
<#
.SYNOPSIS
    多租户迁移 v2 演练：在一次性 PostgreSQL 容器里从零跑一遍迁移 + 验收，用完即删。

.DESCRIPTION
    做的事：
      1. 起一个一次性 postgres 容器（不用 docker compose，避免碰到你现有的库）
      2. 对你现有的 prisma/migrations 执行 migrate deploy（造出"上线前"的真实结构）
      3. 插入种子数据（3 用户 / 1 会议 / 待办 / 决策 / 负责人 / 成员 / 共享 / 审计 / 生成任务 / 通知 / 已读）
      4. 执行 prisma/drafts/0002_multitenant_v2.sql
      5. 执行 prisma/drafts/0002_multitenant_v2.verify.sql（结构 / 数据 / 正例 / 负例 / 回滚往返）
      6. 删除容器

    任何一步失败都会立即使脚本失败并返回退出码 1，绝不会静默通过。

    与 rehearse-multitenant.ps1（v1）的区别：
      * 用 0002 的迁移与验收脚本（v2 不动手机号唯一键与超管唯一索引）
      * 迁移前加了种子自检：种子超管 13800000000 由迁移 20261017163009 内置
        （20261018181520 改的手机号），v1 的 seed 只补两个员工，是有效的。
        但"数据没插进去"这个风险仍然真实：空表会让所有"无跨租户脏数据"的断言
        自动通过，演练显示 PASS 却什么都没测到。所以这里断言
        users≥3 / meetings≥1 / todos≥1，不满足直接抛异常。

.PARAMETER Port
    宿主端口，默认 55433（与 v1 的 55432 错开，两个脚本可以同时跑）。

.PARAMETER KeepContainer
    失败时保留容器，方便进容器看现场（默认失败也删除）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/db/rehearse-multitenant-v2.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 55433,
    [string]$Container = 'meetmind-mt-v2-rehearsal',
    [string]$Image = 'postgres:16-alpine',
    [string]$DbName = 'meetmind',
    [string]$DraftPath = '',
    [switch]$KeepContainer
)

$ErrorActionPreference = 'Stop'

# 让 docker / psql 的中文输出正常显示（PS 5.1 默认按 OEM 代码页解码）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PGCLIENTENCODING = 'UTF8'

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$backend = Join-Path $repoRoot 'backend'
$draftDefault = Join-Path $backend 'prisma\drafts\0002_multitenant_v2.sql'
$verify = Join-Path $backend 'prisma\drafts\0002_multitenant_v2.verify.sql'

# 正式迁移目录。
#
# 演练时先把它移出 prisma/migrations/，跑完 32 个旧迁移、灌完种子再移回来 ——
# 这样 v2 走的是 `prisma migrate deploy` 的真实路径（生产上线走的也是这条），
# 而不是手工 psql。两条路的区别很实际：Prisma 会把它记进 _prisma_migrations，
# 手工跑不会，生产上线时会重跑一遍。
$migrationDir = Join-Path $backend 'prisma\migrations\20261125130000_multi_tenant_v2'
$migrationStash = Join-Path ([System.IO.Path]::GetTempPath()) 'meetmind-mt-v2-migration'
$migrationStashed = $false

# 反例模式：指定 DraftPath 时跑手工 SQL（用来验证后置断言能拦住有 bug 的版本），
# 此时不动正式迁移目录。
$useDraft = [bool]$DraftPath
$draft = if ($useDraft) { $DraftPath } else { $draftDefault }

foreach ($f in @($draft, $verify)) {
    if (-not (Test-Path $f)) { throw "找不到文件：$f" }
}

if (-not $useDraft -and -not (Test-Path $migrationDir)) {
    throw "找不到迁移目录：$migrationDir（v2 是否还没移进 prisma/migrations/？）"
}

function Step([string]$text) {
    Write-Host ""
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Invoke-PsqlFile([string]$hostPath) {
    $name = Split-Path $hostPath -Leaf
    $inside = "/tmp/$name"

    docker cp $hostPath "${Container}:${inside}" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker cp 失败：$name" }

    docker exec $Container psql -U postgres -d $DbName -v ON_ERROR_STOP=1 -f $inside
    if ($LASTEXITCODE -ne 0) { throw "psql 执行失败：$name" }
}

$succeeded = $false

try {
    Step '0) 检查 Docker'
    docker info --format '{{.ServerVersion}}' *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker 引擎不可用，请先启动 Docker Desktop'
    }

    Step "1) 启动一次性容器（127.0.0.1:$Port）"
    docker rm -f $Container *> $null
    docker run -d --name $Container `
        -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=$DbName `
        -p "127.0.0.1:${Port}:5432" $Image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '启动容器失败' }

    $ready = $false
    for ($i = 1; $i -le 30; $i++) {
        docker exec $Container pg_isready -U postgres -d $DbName *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw '等待 PostgreSQL 就绪超时' }
    Write-Host 'PostgreSQL 已就绪'

    Step '2) 应用现有迁移（模拟真实上线前的库）'
    if (-not $useDraft) {
        # 先把 v2 移出去，让 deploy 只跑到 32 个旧迁移为止
        if (Test-Path $migrationStash) { Remove-Item $migrationStash -Recurse -Force }
        Move-Item $migrationDir $migrationStash -Force
        $migrationStashed = $true
        Write-Host '已暂时移出 v2 迁移，本次只应用 32 个旧迁移'
    }

    $env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:${Port}/${DbName}?schema=public"
    Push-Location $backend
    try {
        npx prisma migrate deploy
        if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy 失败' }
    }
    finally {
        Pop-Location
    }

    Step '3) 插入种子数据'
    # users.updated_at 没有 DEFAULT（Prisma 的 @updatedAt 由客户端写），必须显式给。
    #
    # ⚠️ 不要再插 13800000000 —— 迁移 20261017163009 内置了种子超管，
    #    20261018181520 又把它改成这个手机号。再插一次会撞
    #    users_single_super_admin_key。
    #    下面两个普通用户用 ON CONFLICT DO NOTHING，保证脚本可重复执行。
    $seed = @'
INSERT INTO users (phone, password_hash, name, role, is_active, updated_at)
VALUES ('13800000001','x','Employee A','USER', true, now()),
       ('13800000002','x','Employee B','USER', true, now())
ON CONFLICT (phone) DO NOTHING;

INSERT INTO meetings (content, owner_id, title)
SELECT 'weekly sync raw text', id, 'Weekly' FROM users WHERE phone='13800000000';
INSERT INTO meeting_todos (meeting_id, content) SELECT m.id, 'write doc' FROM meetings m;
INSERT INTO meeting_decisions (meeting_id, content) SELECT m.id, 'use pnpm' FROM meetings m;
INSERT INTO meeting_leaders (meeting_id, user_id)
SELECT m.id, u.id FROM meetings m, users u WHERE u.phone='13800000000' ON CONFLICT DO NOTHING;
INSERT INTO meeting_members (meeting_id, user_id)
SELECT m.id, u.id FROM meetings m, users u WHERE u.phone='13800000001' ON CONFLICT DO NOTHING;
INSERT INTO meeting_shares (meeting_id, user_id, permission, granted_by_id)
SELECT m.id, b.id, 'READ', a.id FROM meetings m, users a, users b
 WHERE a.phone='13800000000' AND b.phone='13800000002' ON CONFLICT DO NOTHING;
INSERT INTO audit_logs (actor_id, action, resource_type)
SELECT id,'auth.login','user' FROM users WHERE phone='13800000000';
INSERT INTO audit_logs (actor_id, action, resource_type) VALUES (NULL,'system.cron','system');
INSERT INTO meeting_generations (user_id, content_hash, status)
SELECT id,'deadbeef','SUCCEEDED' FROM users WHERE phone='13800000000';
INSERT INTO meeting_generations (user_id, content_hash, status)
SELECT id,'cafebabe','PENDING' FROM users WHERE phone='13800000002';
INSERT INTO meeting_notices (user_id, meeting_id, content, kind)
SELECT u.id, m.id, 'you were added','update' FROM users u, meetings m WHERE u.phone='13800000001';
INSERT INTO inbox_reads (user_id, item_key)
SELECT id,'notice:1' FROM users WHERE phone='13800000001';

-- 种子自检：数据量为 0 时，"无跨租户脏数据"这类断言会在空表上自动通过，
-- 演练会显示 PASS 但其实什么都没测到。这里把"前提数据存在"变成硬断言。
DO $$
DECLARE
  n_users int; n_meetings int; n_todos int;
BEGIN
  SELECT count(*) INTO n_users    FROM "users";
  SELECT count(*) INTO n_meetings FROM "meetings";
  SELECT count(*) INTO n_todos    FROM "meeting_todos";

  IF n_users < 3 THEN
    RAISE EXCEPTION '种子用户不足：期望 3（1 超管 + 2 员工），实际 %', n_users;
  END IF;
  IF n_meetings < 1 THEN
    RAISE EXCEPTION '种子会议为空：后续跨租户断言会在空表上误判通过';
  END IF;
  IF n_todos < 1 THEN
    RAISE EXCEPTION '种子待办为空：侧表迁移没有被真正验证';
  END IF;

  RAISE NOTICE 'OK: 种子数据就位（users=% meetings=% todos=%）', n_users, n_meetings, n_todos;
END $$;
'@
    $seedPath = Join-Path ([System.IO.Path]::GetTempPath()) 'meetmind-mt-v2-seed.sql'
    [System.IO.File]::WriteAllText($seedPath, $seed, (New-Object System.Text.UTF8Encoding($false)))
    Invoke-PsqlFile $seedPath

    Step '4) 执行多租户迁移（v2）'
    if ($useDraft) {
        # 反例模式：直接跑手工 SQL（v2 目录没被动过）
        Write-Host '反例模式：执行指定的 SQL 文件'
        Invoke-PsqlFile $draft
    }
    else {
        # 真实路径：把 v2 移回 migrations/，交给 prisma 执行
        Move-Item $migrationStash $migrationDir -Force
        $migrationStashed = $false

        Push-Location $backend
        try {
            npx prisma migrate deploy
            if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy（v2）失败' }
        }
        finally {
            Pop-Location
        }
    }

    Step '5) 执行验收（结构 / 数据 / 正例 / 负例 / 回滚往返）'
    Invoke-PsqlFile $verify

    Step '6) 迁移后自检：数据没有被搬走'
    $post = @'
DO $$
DECLARE n int;
BEGIN
  -- 会议必须还在默认组织里，且所有权没变
  SELECT count(*) INTO n FROM "meetings"
   WHERE "tenant_id" <> '00000000-0000-4000-8000-000000000001';
  IF n > 0 THEN
    RAISE EXCEPTION '有 % 场会议被挪出了默认组织（不应该迁移会议）', n;
  END IF;

  -- 原 ADMIN 应该已经被降级，租户内角色由 membership 承担
  SELECT count(*) INTO n FROM "users" WHERE "role" = 'ADMIN';
  IF n > 0 THEN
    RAISE EXCEPTION '仍有 % 个 users.role = ADMIN，未按 v2 降级', n;
  END IF;

  RAISE NOTICE 'OK: 迁移后数据归属正确';
END $$;
'@
    $postPath = Join-Path ([System.IO.Path]::GetTempPath()) 'meetmind-mt-v2-post.sql'
    [System.IO.File]::WriteAllText($postPath, $post, (New-Object System.Text.UTF8Encoding($false)))
    Invoke-PsqlFile $postPath

    Step '7) 迁移结果与 schema.prisma 对齐检查'
    # 手写 SQL 和 schema 是两份独立维护的真相，漂移的后果不是报错，
    # 而是下次 migrate dev 生成一堆"修正迁移"。这里直接对撞一次，输出必须为空。
    Push-Location $backend
    try {
        $diff = npx prisma migrate diff `
            --from-config-datasource `
            --to-schema prisma/schema.prisma `
            --script --exit-code
        if ($LASTEXITCODE -ne 0) {
            throw "迁移结果与 schema.prisma 不一致：`n$diff"
        }
    }
    finally {
        Pop-Location
    }
    Write-Host 'schema 对齐：无差异'

    $succeeded = $true
    Write-Host ""
    Write-Host 'PASS：多租户 v2 迁移演练全部通过' -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host "FAIL：$($_.Exception.Message)" -ForegroundColor Red
}
finally {
    # 无论成败都要把 v2 迁移放回 prisma/migrations/。
    #
    # 不放回去后果很隐蔽：目录少了一个迁移，`migrate deploy` 会当作
    # "这个版本本来就没有它"，生产上线时漏跑 v2，而本地一切正常。
    if ($migrationStashed -and (Test-Path $migrationStash)) {
        if (Test-Path $migrationDir) { Remove-Item $migrationDir -Recurse -Force }
        Move-Item $migrationStash $migrationDir -Force
        Write-Host 'v2 迁移目录已恢复'
    }

    if (-not ($KeepContainer -and -not $succeeded)) {
        docker rm -f $Container *> $null
        Write-Host '演练容器已删除'
    }
    else {
        Write-Host "容器已保留：$Container（进容器排查：docker exec -it $Container psql -U postgres -d $DbName）"
    }
}

if ($succeeded) {
    exit 0
}

exit 1
