#!/usr/bin/env bash
set -euo pipefail

# WARNING: --drop deletes collections in the target database before restoring.
# Use a separate test database first; do not use --drop on the live database casually.
if [[ -z "${MONGODB_URI:-}" ]]; then
  echo "Set MONGODB_URI to the target database URI first." >&2
  exit 1
fi
if [[ $# -ne 1 || ! -s "$1" ]]; then
  echo "Usage: MONGODB_URI='...' ./scripts/restore-mongodb.sh path/to/archive.gz" >&2
  exit 1
fi

mongorestore --uri="$MONGODB_URI" --archive="$1" --gzip
