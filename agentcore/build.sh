#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output=${1:-"$root/.local/agentcore-codezip.zip"}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

uv pip compile "$root/agentcore/pyproject.toml" --quiet -o "$stage/requirements.txt"
uv pip install --python-platform aarch64-manylinux2014 --python-version 3.13 \
  --target "$stage/package" --only-binary=:all: -r "$stage/requirements.txt"
cp "$root/agentcore/main.py" "$stage/package/main.py"
(cd "$stage/package" && zip -qr "$stage/agentcore-codezip.zip" .)
mkdir -p "$(dirname -- "$output")"
mv "$stage/agentcore-codezip.zip" "$output"
printf '%s\n' "$output"
