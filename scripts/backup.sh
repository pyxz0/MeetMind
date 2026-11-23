#!/usr/bin/env bash
#
# 每日数据库备份。
#
# 为什么单独一个脚本：deploy.sh 里的 pg_dump 只在上线前跑。
# 平时没有任何快照 —— 误删或数据损坏时只能回到上一次部署，
# 而那可能是几天前。备份和数据库在同一块盘上，挡不住磁盘故障，
# 但能挡住「手滑删库」这个概率最高的场景。
#
# 由 crontab 调用，见 README 的「备份与恢复」。
# 保留 14 天，更早的自动清理。
#
# 用法：bash scripts/backup.sh

set -euo pipefail

cd "$(dirname "$0")/.."

STAMP=$(date +%Y%m%d-%H%M)
FINAL="backups/db-$STAMP.dump.gz"
TEMP="backups/.tmp-$STAMP.gz"

mkdir -p backups

# 先写临时文件、成功后再改名：
# 中途失败时不会留下半个文件冒充有效备份
docker exec meetmind-db-1 pg_dump -U meetmind -d meetmind -Fc | gzip -6 > "$TEMP"

SIZE=$(stat -c%s "$TEMP" 2>/dev/null || echo 0)

# 空库大约 100 字节，真实数据在 100KB 量级；小于 1KB 一定不对
if [ "$SIZE" -lt 1024 ]; then
  echo "$(date '+%F %T') 备份异常：只有 $SIZE 字节，已丢弃" >&2
  rm -f "$TEMP"
  exit 1
fi

mv "$TEMP" "$FINAL"

# -mtime +14：14 天前的文件
find backups -name 'db-*.dump.gz' -mtime +14 -delete

COUNT=$(find backups -name 'db-*.dump.gz' | wc -l)
echo "$(date '+%F %T') 备份完成 $FINAL（$(numfmt --to=iec "$SIZE")），当前保留 $COUNT 份"
