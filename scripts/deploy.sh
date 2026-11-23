#!/usr/bin/env bash
#
# 生产部署：只拉镜像，不在服务器上构建。
#
# 为什么：这台机器 2 核 2G，跑 docker build 会把系统压到用户态进程无法调度
# —— 2026-11-22 出过一次，线上不可用十几分钟才重启恢复。
# 镜像由 GitHub Actions 构建并推到**阿里云 ACR**（见 .github/workflows/images.yml）。
#
# 为什么是 ACR 而不是 GHCR：ghcr.io 的 manifest 能拿到，但镜像层在国内被阻断，
# 服务器 `docker pull` 卡在零进度（实测 150 秒无任何下载）。
#
# 用法：
#   bash scripts/deploy.sh            # 用 latest
#   bash scripts/deploy.sh <git-sha>  # 回滚到某次提交对应的镜像
#
# 需要在 .env 里配好 ACR 凭据（ACR 个人版默认私有，不登录拉不动）：
#   ACR_REGISTRY=registry.cn-guangzhou.aliyuncs.com   # 可选，默认就用这个
#   ACR_NAMESPACE=meetmind                             # 可选，默认 meetmind
#   ACR_USERNAME=<阿里云账号全名或 RAM 用户名>
#   ACR_PASSWORD=<ACR 固定密码>

set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-latest}"

# 从 .env 读一个值：不 source 整个文件，避免值里的空格/引号把 shell 弄乱
read_env() {
  [ -f .env ] || return 0

  grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

REGISTRY="$(read_env ACR_REGISTRY)"
REGISTRY="${REGISTRY:-registry.cn-guangzhou.aliyuncs.com}"

NAMESPACE="$(read_env ACR_NAMESPACE)"
NAMESPACE="${NAMESPACE:-meetmind}"

ACR_USER="$(read_env ACR_USERNAME)"
ACR_PASS="$(read_env ACR_PASSWORD)"

PREFIX="$REGISTRY/$NAMESPACE/meetmind"

export BACKEND_IMAGE="$PREFIX-backend:$TAG"
export FRONTEND_IMAGE="$PREFIX-frontend:$TAG"
export MIGRATE_IMAGE="$PREFIX-migrate:$TAG"

echo "==> 镜像标签：$TAG（$REGISTRY/$NAMESPACE）"

# ACR 个人版默认私有仓库。没配凭据就直说，别等到 pull 401 才发现
if [ -z "$ACR_PASS" ]; then
  echo "!!  .env 里没有 ACR_PASSWORD，无法登录 ACR。" >&2
  echo "    去 ACR 控制台「访问凭证」设置固定密码，然后写进 .env。" >&2

  exit 1
fi

echo "==> 登录 ACR"
echo "$ACR_PASS" | docker login --username="$ACR_USER" --password-stdin "$REGISTRY" > /dev/null

echo "==> 备份数据库"
mkdir -p backups
# 用户名/库名与 .env 里的 POSTGRES_USER / POSTGRES_DB 保持一致
docker exec meetmind-db-1 pg_dump -U meetmind -d meetmind -Fc \
  > "backups/pre-deploy-$(date +%m%d%H%M).dump"
ls -lh backups | tail -1

echo "==> 拉取镜像"
docker compose --profile prod pull backend frontend migrate

echo "==> 执行迁移（无待应用迁移时直接退出）"
docker compose --profile prod run --rm migrate

echo "==> 重启服务"
docker compose --profile prod up -d --no-build

echo "==> 当前状态"
docker ps --format '{{.Names}}\t{{.Status}}'

echo "==> 完成。抽查："
echo "    curl -s -o /dev/null -w '%{http_code}' https://meetmind.asia/"
