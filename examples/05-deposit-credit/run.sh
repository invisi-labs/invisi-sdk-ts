#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ ! -f ../.env ] && [ ! -f .env ]; then
  echo "Please copy ../shared/.env.example to ../.env and fill in the configuration first"
  exit 1
fi

pnpm install
pnpm start
