#!/bin/sh
# Fetch the embedding model files into the directory the server looks in first.
#
# The directory name and file names come from src/model-manifest.json — the same
# manifest the Rust loader embeds and the VS Code installer reads — so a rename
# cannot leave this script downloading files nobody looks for.
#
# Usage: scripts/fetch-model.sh
#
# Writes to $PALI_MODEL_DIR when set, otherwise ./models/<dir> relative to the
# current directory, so running it from the workspace root populates the path
# the loader resolves (ADR-0049). Pali never downloads the model itself; this is
# a developer/CI convenience and needs only curl, sed, and mkdir.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
manifest="$root/src/model-manifest.json"
base_url="https://huggingface.co"

if [ ! -f "$manifest" ]; then
  echo "fetch-model: missing $manifest" >&2
  exit 1
fi

# First value of a "key": "string" pair in the manifest.
manifest_value() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$manifest" | head -n 1
}

model_id=$(manifest_value id)
dir_name=$(manifest_value dir)
files=$(sed -n '/"files"[[:space:]]*:[[:space:]]*{/,/}/p' "$manifest" |
  sed -n 's/^[[:space:]]*"[a-z]*"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [ -z "$model_id" ] || [ -z "$dir_name" ] || [ -z "$files" ]; then
  echo "fetch-model: $manifest must define \"id\", \"dir\", and a \"files\" object" >&2
  exit 1
fi

target=${PALI_MODEL_DIR:-"models/$dir_name"}
mkdir -p "$target"

for file in $files; do
  dest="$target/$file"
  if [ -s "$dest" ]; then
    echo "fetch-model: $file already present"
    continue
  fi
  echo "fetch-model: fetching $model_id/$file"
  curl -fsSL --retry 3 --retry-delay 1 -o "$dest.part" "$base_url/$model_id/resolve/main/$file"
  mv "$dest.part" "$dest"
done

echo "fetch-model: $model_id is provisioned in $target"
