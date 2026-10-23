# 兼容 Windows PowerShell 5.1 与 PowerShell 7（本机只装了 5.1，所以不依赖 7 的语法）
<#
.SYNOPSIS
    多租户迁移演练：在一次性 PostgreSQL 容器里从零跑一遍迁移 + 验收，用完即删。

.DESCRIPTION
    做的事：
      1. 起一个一次性 postgres 容器（不用 docker compose，避免碰到你现有的库）
      2. 对你现有的 prisma/migrations 执行 migrate deploy（造出"上线前"的真实结构）
      3. 插入一批种子数据（会议 / 待办 / 审计 / 生成任务 / 通知…）
      4. 执行 prisma/drafts/0001_multitenant.sql
      5. 执行 prisma/drafts/0001_multitenant.verify.sql（正例 + 负例 + 回滚往返）
      6. 删除容器

    任何一步失败都会立即使脚本失败并返回退出码 1，绝不会静默通过。

.PARAMETER Port
    宿主端口，默认 55432。只绑定 127.0.0.1，不会暴露到局域网。

.PARAMETER KeepContainer
    失败时保留容器，方便进容器看现场（默认失败也删除）。

.EXAMPLE
    pwsh scripts/db/rehearse-multitenant.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 55432,
    [string]$Container = 'meetmind-mt-rehearsal',
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
$draftDefault = Join-Path $backend 'prisma\drafts\0001_multitenant.sql'
$verify = Join-Path $backend 'prisma\drafts\0001_multitenant.verify.sql'

# 允许指定别的迁移文件：用来做"反例回归"——拿一个有 bug 的版本跑一遍，
# 确认后置断言会把它拦下来（见 docs/multi-tenant-plan.md §10）
$draft = if ($DraftPath) { $DraftPath } else { $draftDefault }

foreach ($f in @($draft, $verify)) {
    if (-not (Test-Path $f)) { throw "找不到文件：$f" }
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
    $seed = @'
INSERT INTO users (phone, password_hash, name, role, is_active, updated_at)
VALUES ('13800000001','x','Employee A','USER', true, now()),
       ('13800000002','x','Employee B','USER', true, now());

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
'@
    $seedPath = Join-Path ([System.IO.Path]::GetTempPath()) 'meetmind-mt-seed.sql'
    [System.IO.File]::WriteAllText($seedPath, $seed, (New-Object System.Text.UTF8Encoding($false)))
    Invoke-PsqlFile $seedPath

    Step '4) 执行多租户迁移草稿'
    Invoke-PsqlFile $draft

    Step '5) 执行验收（正例 / 负例 / 回滚往返）'
    Invoke-PsqlFile $verify

    $succeeded = $true
    Write-Host ""
    Write-Host 'PASS：多租户迁移演练全部通过' -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host "FAIL：$($_.Exception.Message)" -ForegroundColor Red
}
finally {
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
