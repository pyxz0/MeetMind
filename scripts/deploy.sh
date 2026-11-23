#!/usr/bin/env bash
#
# 生产部署：只拉镜像，不在服务器上构建。
#
# 为什么这么改：这台机器 2 核 2G，跑 docker build 会把系统压到用户态进程
# 无法调度 —— 2026-11-22 出过一次，线上不可用十几分钟才重启恢复。
# 现在镜像由 GitHub Actions 构建并推到 GHCR（见 .github/workflows/images.yml），
# 服务器只做 pull + up，全程十几秒，不再消耗构建资源。
#
# 用法：
#   ./scripts/deploy.sh            # 用 latest
#   ./scripts/deploy.sh <git-sha>  # 回滚到某次提交对应的镜像
#
# 前置：服务器需能访问 ghcr.io。若镜像是私有的，先执行一次
#   echo <PAT> | docker login ghcr.io -u <github-username> --password-stdin

set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-latest}"
PREFIX="ghcr.io/pyxz0/meetmind"

export BACKEND_IMAGE="$PREFIX-backend:$TAG"
export FRONTEND_IMAGE="$PREFIX-frontend:$TAG"
export MIGRATE_IMAGE="$PREFIX-migrate:$TAG"

echo "==> 镜像标签：$TAG"

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
