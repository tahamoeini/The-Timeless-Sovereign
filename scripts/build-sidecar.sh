#!/usr/bin/env bash
set -eu

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_directory="$repo_root/apps/desktop/src-tauri/binaries"
work_directory="$repo_root/.build/pyinstaller"
python_executable="${PYTHON:-python3}"
target_triple="$(rustc --print host-tuple)"
if [ -z "$target_triple" ]; then
  printf '%s\n' "Could not determine the Rust target triple." >&2
  exit 1
fi

mkdir -p "$output_directory" "$work_directory"
cd "$repo_root"
"$python_executable" -m PyInstaller --noconfirm --clean --onefile --name "lke-api-$target_triple" \
  --paths backend --distpath "$output_directory" --workpath "$work_directory" \
  --specpath "$work_directory" --collect-all fastapi --collect-all starlette \
  --collect-all pydantic --collect-all uvicorn --collect-all anyio \
  backend/sidecar_entry.py

printf 'Built lke-api-%s in %s\n' "$target_triple" "$output_directory"
