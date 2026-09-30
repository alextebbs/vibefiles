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
# models.json is NOT touched — Squire's agentconfig owns it.
link_dir_contents "$DOTFILES_DIR/.pi/agent/extensions" "$HOME/.pi/agent/extensions"

# Pi settings -> deep-merge into the live ~/.pi/agent/settings.json.
#
# Squire's agentconfig owns this file (it seeds the theme, injects provider
# packages like pi-codex-token) but only ever edits it surgically — every
# other key is preserved and malformed files are left untouched. So instead
# of skipping the file (which silently drops these prefs in every Squire
# env), merge it: repo values win for the keys we define, everything Squire
# set survives, and the `packages` array is a deduplicated union so Squire's
# injected packages are never dropped.
merge_pi_settings() {
  local src="$DOTFILES_DIR/.pi/agent/settings.json"
  local dst="$HOME/.pi/agent/settings.json"
  if ! command -v jq >/dev/null 2>&1; then
    echo "install.sh: jq not found; skipping settings.json merge"
    return 0
  fi
  [ -f "$src" ] || return 0
  mkdir -p "$(dirname "$dst")"
  if [ -s "$dst" ] && ! jq -e . "$dst" >/dev/null 2>&1; then
    echo "install.sh: $dst is not valid JSON; leaving it untouched"
    return 0
  fi
  local live out
  live=$(mktemp)
  out=$(mktemp)
  if [ -s "$dst" ]; then cp "$dst" "$live"; else echo '{}' > "$live"; fi
  # Deep merge; arrays: union with dedupe, live entries first.
  jq -s '
    def union($a; $b):
      [($a // [])[], ($b // [])[]]
      | reduce .[] as $x ([]; if (. | index($x)) == null then . + [$x] else . end);
    . as $in
    | (($in[0] // {}) * ($in[1] // {}))
    | if ($in[1] | has("packages"))
      then .packages = union($in[0].packages; $in[1].packages)
      else . end
  ' "$live" "$src" > "$out" || {
    echo "install.sh: settings.json merge failed; leaving $dst untouched"
    rm -f "$live" "$out"
    return 0
  }
  if ! cmp -s "$out" "$dst"; then
    mv "$out" "$dst"
    echo "install.sh: merged pi settings into $dst"
  fi
  rm -f "$live" "$out"
}
merge_pi_settings