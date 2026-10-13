#!/usr/bin/env bash
set -euo pipefail

# Requires MongoDB Database Tools (`mongodump`) and MONGODB_URI in the environment.
# This creates a compressed, full-database backup; it does NOT delete source records.
if [[ -z "${MONGODB_URI:-}" ]]; then
  echo "Set MONGODB_URI before running this script." >&2
  exit 1
fi

mkdir -p backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="backups/madrasa-mongodb-${STAMP}.archive.gz"

mongodump --uri="$MONGODB_URI" --archive="$OUT" --gzip
test -s "$OUT"
sha256sum "$OUT" > "${OUT}.sha256"
echo "Backup created: $OUT"
echo "Checksum created: ${OUT}.sha256"
echo "Copy both files to a second, secure location. Test restore before any cleanup."
