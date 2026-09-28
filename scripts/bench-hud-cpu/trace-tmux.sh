#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${BENCH_TMUX_TRACE:-}" ]]; then
  printf '%q ' "$@" >> "$BENCH_TMUX_TRACE"
  printf '\n' >> "$BENCH_TMUX_TRACE"
fi

exec "${BENCH_REAL_TMUX:-/usr/bin/tmux}" "$@"
