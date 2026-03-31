#!/bin/bash
set -e
PROTOCOL_ROOT="${1:-../../../invisi-protocol}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/circuits"

mkdir -p "$DEST"

count=0
for circuit_dir in "$PROTOCOL_ROOT"/circuits/*/; do
  name=$(basename "$circuit_dir")
  src="$circuit_dir/target/$name.json"
  if [ -f "$src" ]; then
    cp "$src" "$DEST/$name.json"
    echo "Synced: $name.json"
    count=$((count + 1))
  else
    echo "WARN: $src not found, skipping"
  fi
done

echo "Done: $count circuits synced to $DEST"
