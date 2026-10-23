#!/usr/bin/env bash
set -euo pipefail

# Simple PostgreSQL backup script (pg_dump)
# Usage (cron example):
#   0 2 * * * cd /path/to/project && ./scripts/pg-backup.sh >> ./logs/pg-backup.log 2>&1

: "${DATABASE_URL:?DATABASE_URL is required for backups}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

TS="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/siymon_${TS}.sql.gz"

echo "[backup] starting -> $OUT"

pg_dump "$DATABASE_URL" | gzip > "$OUT"

echo "[backup] done"

# Retention cleanup
find "$BACKUP_DIR" -type f -name 'siymon_*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete || true
