#!/usr/bin/env bash
set -euo pipefail

SOCKET=omx-hook-format-inspect
SLOT=12345

cleanup() {
  tmux -L "$SOCKET" kill-server >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

leader=$(tmux -L "$SOCKET" new-session -d -P -F '#{pane_id}' -s inspect 'sleep 300')
tmux -L "$SOCKET" set-hook -t inspect "client-resized[$SLOT]" 'run-shell -b true'
tmux -L "$SOCKET" set-hook -w -t "$leader" "window-layout-changed[$SLOT]" 'run-shell -b true'
tmux -L "$SOCKET" set-hook -t inspect "after-split-window[$SLOT]" 'run-shell -b true'

tab_format=$'#{pane_id}\t#{client-resized[12345]}\t#{window-layout-changed[12345]}\t#{after-split-window[12345]}'
pipe_format='#{pane_id}|#{client-resized[12345]}|#{window-layout-changed[12345]}|#{after-split-window[12345]}'

printf 'tmux=%s\n' "$(tmux -V)"
printf 'LANG=<%s> LC_ALL=<%s>\n' "${LANG-}" "${LC_ALL-}"
printf '%s\n' 'tab-delimited raw bytes:'
tmux -L "$SOCKET" display-message -p -t "$leader" "$tab_format" | od -An -tx1 -v
printf '%s\n' 'pipe-delimited raw bytes:'
tmux -L "$SOCKET" display-message -p -t "$leader" "$pipe_format" | od -An -tx1 -v
printf '%s\n' 'show-hooks:'
tmux -L "$SOCKET" show-hooks -t inspect
tmux -L "$SOCKET" show-hooks -w -t "$leader"
