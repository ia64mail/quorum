#!/usr/bin/env bash
set -euo pipefail

export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"

echo "Building with HOST_UID=$HOST_UID, HOST_GID=$HOST_GID"

docker compose build "$@"
docker compose up "$@"