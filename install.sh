#!/usr/bin/env bash
# Squire dotfiles installer. Runs via `bash -c` with cwd=$DOTFILES_DIR
# after the repo is cloned to ~/.dotfiles. Must be idempotent.
set -euo pipefail

DOTFILES_DIR="${DOTFILES_DIR:-$HOME/.dotfiles}"

link_dir_contents() {
  # Symlink each regular file from $1 into $2, overwriting existing links.
  local src_dir="$1" dst_dir="$2"
  [ -d "$src_dir" ] || return 0
  mkdir -p "$dst_dir"
  find "$src_dir" -maxdepth 1 -type f | while read -r f; do
    ln -sfn "$f" "$dst_dir/$(basename "$f")"
  done
}

# Pi extensions -> ~/.pi/agent/extensions/
# Do NOT link settings.json/models.json — Squire's agentconfig owns those.
link_dir_contents "$DOTFILES_DIR/.pi/agent/extensions" "$HOME/.pi/agent/extensions"
