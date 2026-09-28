#!/usr/bin/env bash
set -euo pipefail

MODE=cpu
CASES=1,6
WARMUP_SECONDS=10
MEASURE_SECONDS=30
REPEATS=3
DIAGNOSTIC_SECONDS=15
LABEL=candidate
SOURCE_REVISION=
REQUIRE_HOOK_OPTIONS=1

usage() {
  cat <<'EOF'
Usage: run-in-container.sh [options]

Options:
  --mode cpu|diagnostic|real-tmux-tests
  --cases 1,6 (optional: 1,6,19)
  --warmup-seconds N
  --measure-seconds N
  --repeats N
  --diagnostic-seconds N
  --label NAME
  --source-revision GIT_SHA
  --require-hook-options 0|1
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE=$2; shift 2 ;;
    --cases) CASES=$2; shift 2 ;;
    --warmup-seconds) WARMUP_SECONDS=$2; shift 2 ;;
    --measure-seconds) MEASURE_SECONDS=$2; shift 2 ;;
    --repeats) REPEATS=$2; shift 2 ;;
    --diagnostic-seconds) DIAGNOSTIC_SECONDS=$2; shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    --source-revision) SOURCE_REVISION=$2; shift 2 ;;
    --require-hook-options) REQUIRE_HOOK_OPTIONS=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$MODE" != cpu && "$MODE" != diagnostic && "$MODE" != real-tmux-tests ]]; then
  echo "--mode must be cpu, diagnostic, or real-tmux-tests" >&2
  exit 2
fi
[[ "$REQUIRE_HOOK_OPTIONS" == 0 || "$REQUIRE_HOOK_OPTIONS" == 1 ]] || { echo "--require-hook-options must be 0 or 1" >&2; exit 2; }
for value in "$WARMUP_SECONDS" "$MEASURE_SECONDS" "$REPEATS" "$DIAGNOSTIC_SECONDS"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "Durations and repeats must be positive integers" >&2; exit 2; }
done
[[ -d /repo ]] || { echo "/repo must be a bind-mounted repository" >&2; exit 2; }

WORK_ROOT=/work
REPO_ROOT=$WORK_ROOT/repo
RUNTIME_ROOT=$WORK_ROOT/runtime
TMUX_SOCKET=omx-hud-cpu-bench
REAL_TMUX=$(command -v tmux)
RECONCILE_TRACE=$WORK_ROOT/reconcile.trace
TMUX_TRACE=$WORK_ROOT/tmux.trace
declare -a SESSION_NAMES=()
declare -a LEADER_IDS=()
declare -a HUD_IDS=()
HEALTH_ERROR=not_checked

cleanup() {
  "$REAL_TMUX" -L "$TMUX_SOCKET" kill-server >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

reset_runtime_root() {
  local attempt
  for ((attempt = 1; attempt <= 20; attempt += 1)); do
    rm -rf "$RUNTIME_ROOT" 2>/dev/null || true
    [[ ! -e "$RUNTIME_ROOT" ]] && return
    sleep 0.1
  done
  echo "Unable to clear runtime root after tmux shutdown" >&2
  exit 1
}

rm -rf "$REPO_ROOT"
reset_runtime_root
mkdir -p "$REPO_ROOT" "$RUNTIME_ROOT"
(cd /repo && tar --exclude='./node_modules' --exclude='./dist' --exclude='./.omx' -cf - .) \
  | tar -xf - -C "$REPO_ROOT"

cd "$REPO_ROOT"
npm ci --no-audit --no-fund >&2
npm run build >&2

COMMIT=${SOURCE_REVISION:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}
SOURCE_HASH=$(find src/hud -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
RUNTIME_HASH=$(find src/hud -type f ! -path '*/__tests__/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')

read_cpu_usage_us() {
  if [[ -r /sys/fs/cgroup/cpu.stat ]]; then
    awk '$1 == "usage_usec" { print $2; found=1 } END { if (!found) exit 1 }' /sys/fs/cgroup/cpu.stat
    return
  fi
  if [[ -r /sys/fs/cgroup/cpuacct/cpuacct.usage ]]; then
    awk '{ printf "%.0f\n", $1 / 1000 }' /sys/fs/cgroup/cpuacct/cpuacct.usage
    return
  fi
  echo "No readable cgroup CPU accounting file" >&2
  exit 1
}

read_pids_max_events() {
  if [[ -r /sys/fs/cgroup/pids.events ]]; then
    awk '$1 == "max" { print $2; found=1 } END { if (!found) print 0 }' /sys/fs/cgroup/pids.events
  else
    printf '0\n'
  fi
}

tmux_real() {
  "$REAL_TMUX" -L "$TMUX_SOCKET" "$@"
}

create_project() {
  local project=$1
  mkdir -p "$project/.omx/state"
  git -C "$project" init -q
  git -C "$project" config user.email bench@example.invalid
  git -C "$project" config user.name 'HUD CPU benchmark'
  printf 'HUD benchmark fixture\n' > "$project/README.md"
  git -C "$project" add README.md
  git -C "$project" commit -qm init
}

start_case() {
  local count=$1
  local diagnostic=$2
  local index session leader hud project hud_command

  cleanup
  reset_runtime_root
  mkdir -p "$RUNTIME_ROOT"
  : > "$RECONCILE_TRACE"
  : > "$TMUX_TRACE"
  SESSION_NAMES=()
  LEADER_IDS=()
  HUD_IDS=()

  for ((index = 1; index <= count; index += 1)); do
    session="hud-bench-$index"
    project="$RUNTIME_ROOT/project-$index"
    create_project "$project"
    leader=$(tmux_real new-session -d -P -F '#{pane_id}' -s "$session" -x 120 -y 40 -c "$project" 'sleep 86400')
    tmux_real set-option -t "$session" '@omx_instance_id' "bench-$index"

    if [[ "$diagnostic" == 1 ]]; then
      hud_command="exec env PATH=/bench:\$PATH NODE_OPTIONS=--require=/bench/trace-preload.cjs BENCH_REAL_TMUX=$REAL_TMUX BENCH_RECONCILE_TRACE=$RECONCILE_TRACE BENCH_TMUX_TRACE=$TMUX_TRACE OMX_ENTRY_PATH=$REPO_ROOT/dist/cli/omx.js OMX_STARTUP_CWD=$REPO_ROOT OMX_TMUX_HUD_OWNER=1 OMX_SESSION_ID=bench-$index OMX_TMUX_HUD_LEADER_PANE=$leader OMX_ROOT=$project node $REPO_ROOT/dist/cli/omx.js hud --watch"
    else
      hud_command="exec env OMX_ENTRY_PATH=$REPO_ROOT/dist/cli/omx.js OMX_STARTUP_CWD=$REPO_ROOT OMX_TMUX_HUD_OWNER=1 OMX_SESSION_ID=bench-$index OMX_TMUX_HUD_LEADER_PANE=$leader OMX_ROOT=$project node $REPO_ROOT/dist/cli/omx.js hud --watch"
    fi
    hud=$(tmux_real split-window -d -P -F '#{pane_id}' -v -l 2 -t "$leader" -c "$project" "$hud_command")
    SESSION_NAMES+=("$session")
    LEADER_IDS+=("$leader")
    HUD_IDS+=("$hud")
  done
}

case_is_healthy() {
  local expected=$1
  local index session leader hud snapshot session_hooks window_hooks leader_row hud_row
  local pane_format
  local leader_session leader_window leader_id leader_dead leader_pid leader_left leader_top leader_width leader_height leader_bottom leader_window_width leader_window_height leader_command
  local hud_session hud_window hud_id hud_dead hud_pid hud_left hud_top hud_width hud_height hud_bottom hud_window_width hud_window_height hud_start_command
  local resize_slot layout_slot split_slot resize_identity layout_identity split_identity slot_index option_prefix observed_identity observed_expected observed_configuration

  HEALTH_ERROR=checking
  pane_format='#{session_id}|#{window_id}|#{pane_id}|#{pane_dead}|#{pane_pid}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_bottom}|#{window_width}|#{window_height}|#{pane_start_command}'
  [[ "${#HUD_IDS[@]}" == "$expected" ]] || { HEALTH_ERROR=tracked_hud_count; return 1; }
  for ((index = 0; index < expected; index += 1)); do
    session=${SESSION_NAMES[$index]}
    leader=${LEADER_IDS[$index]}
    hud=${HUD_IDS[$index]}
    snapshot=$(tmux_real list-panes -t "$hud" -F "$pane_format") || { HEALTH_ERROR=list_panes; return 1; }
    [[ "$(grep -c '^' <<< "$snapshot")" == 2 ]] || { HEALTH_ERROR=window_pane_count; return 1; }
    leader_row=$(grep -F "|$leader|" <<< "$snapshot") || { HEALTH_ERROR=leader_row; return 1; }
    hud_row=$(grep -F "|$hud|" <<< "$snapshot") || { HEALTH_ERROR=hud_row; return 1; }

    IFS='|' read -r leader_session leader_window leader_id leader_dead leader_pid leader_left leader_top leader_width leader_height leader_bottom leader_window_width leader_window_height leader_command <<< "$leader_row"
    IFS='|' read -r hud_session hud_window hud_id hud_dead hud_pid hud_left hud_top hud_width hud_height hud_bottom hud_window_width hud_window_height hud_start_command <<< "$hud_row"

    [[ "$leader_id" == "$leader" && "$hud_id" == "$hud" ]] || { HEALTH_ERROR=pane_identity; return 1; }
    [[ "$leader_session" == "$hud_session" && "$leader_window" == "$hud_window" ]] || { HEALTH_ERROR=scope_identity; return 1; }
    [[ "$leader_dead" == 0 && "$hud_dead" == 0 ]] || { HEALTH_ERROR=pane_dead; return 1; }
    [[ "$leader_pid" =~ ^[1-9][0-9]*$ && "$hud_pid" =~ ^[1-9][0-9]*$ ]] || { HEALTH_ERROR=pane_pid_format; return 1; }
    kill -0 "$leader_pid" 2>/dev/null || { HEALTH_ERROR=leader_pid_dead; return 1; }
    kill -0 "$hud_pid" 2>/dev/null || { HEALTH_ERROR=hud_pid_dead; return 1; }
    [[ "$hud_start_command" == *'OMX_TMUX_HUD_OWNER=1'* ]] || { HEALTH_ERROR=owner_marker; return 1; }
    [[ "$hud_start_command" == *"OMX_SESSION_ID=bench-$((index + 1))"* ]] || { HEALTH_ERROR=owner_session; return 1; }
    [[ "$hud_start_command" == *"OMX_TMUX_HUD_LEADER_PANE=$leader"* ]] || { HEALTH_ERROR=owner_leader; return 1; }
    [[ "$hud_start_command" == *'hud --watch'* ]] || { HEALTH_ERROR=watch_command; return 1; }

    [[ "$leader_left" == 0 && "$hud_left" == 0 ]] || { HEALTH_ERROR=left_geometry; return 1; }
    [[ "$leader_width" == "$leader_window_width" && "$hud_width" == "$hud_window_width" ]] || { HEALTH_ERROR=width_geometry; return 1; }
    [[ "$leader_window_width" == "$hud_window_width" && "$leader_window_height" == "$hud_window_height" ]] || { HEALTH_ERROR=window_geometry; return 1; }
    (( hud_top == leader_bottom + 2 )) || { HEALTH_ERROR=vertical_adjacency; return 1; }
    (( hud_bottom == hud_window_height - 1 )) || { HEALTH_ERROR=bottom_geometry; return 1; }

    read -r resize_slot layout_slot split_slot resize_identity layout_identity split_identity < <(node /bench/hook-slots.cjs "$leader_session" "$leader_window" "$leader")
    session_hooks=$(tmux_real show-hooks -t "$session") || { HEALTH_ERROR=session_hooks_query; return 1; }
    window_hooks=$(tmux_real show-hooks -w -t "$leader") || { HEALTH_ERROR=window_hooks_query; return 1; }
    grep -Fq "$resize_slot" <<< "$session_hooks" || { HEALTH_ERROR=resize_hook; return 1; }
    grep -Fq "$layout_slot" <<< "$window_hooks" || { HEALTH_ERROR=layout_hook; return 1; }
    grep -Fq "$split_slot" <<< "$session_hooks" || { HEALTH_ERROR=split_hook; return 1; }
    if [[ "$REQUIRE_HOOK_OPTIONS" == 1 ]]; then
      for hook_data in \
        "$resize_slot $resize_identity" \
        "$layout_slot $layout_identity" \
        "$split_slot $split_identity"; do
        read -r hook_slot expected_identity <<< "$hook_data"
        slot_index=${hook_slot#*[}
        slot_index=${slot_index%]}
        option_prefix=${hook_slot%%[*}
        option_prefix=${option_prefix//-/_}
        observed_identity=$(tmux_real show-options -t "$leader_session" -v "@omx_hook_identity_${option_prefix}_${slot_index}") || { HEALTH_ERROR=hook_identity_query; return 1; }
        observed_expected=$(tmux_real show-options -t "$leader_session" -v "@omx_hook_expected_${option_prefix}_${slot_index}") || { HEALTH_ERROR=hook_expected_query; return 1; }
        observed_configuration=$(tmux_real show-options -t "$leader_session" -v "@omx_hook_configuration_${option_prefix}_${slot_index}") || { HEALTH_ERROR=hook_configuration_query; return 1; }
        [[ "$observed_identity" == "$expected_identity" ]] || { HEALTH_ERROR=hook_identity; return 1; }
        [[ -n "$observed_expected" ]] || { HEALTH_ERROR=hook_expected; return 1; }
        [[ "$observed_configuration" =~ ^[0-9a-f]{64}$ ]] || { HEALTH_ERROR=hook_configuration; return 1; }
      done
    fi
  done
  HEALTH_ERROR=healthy
}

verify_case() {
  local expected=$1
  local deadline=$((SECONDS + 20))
  while (( SECONDS < deadline )); do
    case_is_healthy "$expected" && return
    sleep 1
  done
  echo "HUD topology or hook verification failed for $expected watchers: $HEALTH_ERROR" >&2
  tmux_real list-panes -a -F '#{session_name} #{session_id} #{window_id} #{pane_id} #{pane_dead} #{pane_pid} #{pane_left},#{pane_top} #{pane_width}x#{pane_height} #{window_width}x#{window_height} #{pane_start_command}' >&2 || true
  local session
  for session in "${SESSION_NAMES[@]}"; do
    printf '%s\n' "Hooks for $session:" >&2
    tmux_real show-hooks -t "$session" >&2 || true
    tmux_real show-hooks -w -t "$session" >&2 || true
  done
  exit 1
}

emit_metadata() {
  jq -cn \
    --arg type metadata \
    --arg variant_label "$LABEL" \
    --arg mode "$MODE" \
    --arg commit "$COMMIT" \
    --arg source_hash "$SOURCE_HASH" \
    --arg runtime_hash "$RUNTIME_HASH" \
    --arg node "$(node --version)" \
    --arg tmux "$(tmux -V)" \
    --arg kernel "$(uname -r)" \
    --arg pids_limit "${BENCH_PIDS_LIMIT:-unlimited}" \
    '{type:$type,label:$variant_label,mode:$mode,commit:$commit,source_hash:$source_hash,runtime_hash:$runtime_hash,node:$node,tmux:$tmux,kernel:$kernel,pids_limit:$pids_limit}'
}

run_cpu_case() {
  local count=$1
  local repeat before after delta percent pids_before pids_after
  start_case "$count" 0
  verify_case "$count"
  sleep "$WARMUP_SECONDS"

  for ((repeat = 1; repeat <= REPEATS; repeat += 1)); do
    before=$(read_cpu_usage_us)
    pids_before=$(read_pids_max_events)
    sleep "$MEASURE_SECONDS"
    after=$(read_cpu_usage_us)
    pids_after=$(read_pids_max_events)
    verify_case "$count"
    if (( pids_after > pids_before )); then
      echo "PID limit was reached during the measured interval; sample is invalid" >&2
      exit 1
    fi
    delta=$((after - before))
    percent=$(awk -v used="$delta" -v seconds="$MEASURE_SECONDS" 'BEGIN { printf "%.4f", used / (seconds * 10000) }')
    jq -cn \
      --arg type cpu \
      --arg variant_label "$LABEL" \
      --argjson sessions "$count" \
      --argjson repeat "$repeat" \
      --argjson duration_seconds "$MEASURE_SECONDS" \
      --argjson usage_usec "$delta" \
      --argjson one_core_percent "$percent" \
      --argjson pids_max_events "$pids_after" \
      '{type:$type,label:$variant_label,sessions:$sessions,repeat:$repeat,duration_seconds:$duration_seconds,usage_usec:$usage_usec,one_core_percent:$one_core_percent,pids_max_events:$pids_max_events}'
  done
}

run_diagnostic_case() {
  local count=$1
  local reconcile_count set_hook_count tmux_calls watcher_count
  start_case "$count" 1
  verify_case "$count"
  sleep "$WARMUP_SECONDS"
  : > "$RECONCILE_TRACE"
  : > "$TMUX_TRACE"
  sleep "$DIAGNOSTIC_SECONDS"
  verify_case "$count"

  reconcile_count=$(wc -l < "$RECONCILE_TRACE")
  set_hook_count=$(grep -cE '(^| )set-hook( |$)' "$TMUX_TRACE" || true)
  tmux_calls=$(wc -l < "$TMUX_TRACE")
  watcher_count=$(tmux_real list-panes -a -F '#{pane_start_command}' | grep -c -- 'hud --watch' || true)
  jq -cn \
    --arg type diagnostic \
    --arg variant_label "$LABEL" \
    --argjson sessions "$count" \
    --argjson duration_seconds "$DIAGNOSTIC_SECONDS" \
    --argjson reconcile_children "$reconcile_count" \
    --argjson set_hook_calls "$set_hook_count" \
    --argjson tmux_cli_calls "$tmux_calls" \
    --argjson live_watchers "$watcher_count" \
    '{type:$type,label:$variant_label,sessions:$sessions,duration_seconds:$duration_seconds,reconcile_children:$reconcile_children,set_hook_calls:$set_hook_calls,tmux_cli_calls:$tmux_cli_calls,live_watchers:$live_watchers}'
}

run_real_tmux_tests() {
  local unit_status suite_status status
  set +e
  CI=1 node --test --test-name-pattern='hook health' dist/hud/__tests__/tmux.test.js >&2
  unit_status=$?
  CI=1 node --test dist/hud/__tests__/tmux-split-realtmux.test.js >&2
  suite_status=$?
  set -e
  if [[ "$unit_status" == 0 && "$suite_status" == 0 ]]; then status=0; else status=1; fi
  jq -cn \
    --arg type real_tmux_tests \
    --arg variant_label "$LABEL" \
    --argjson passed "$([[ "$status" == 0 ]] && printf true || printf false)" \
    --argjson hook_health_exit_code "$unit_status" \
    --argjson hud_suite_exit_code "$suite_status" \
    --argjson exit_code "$status" \
    '{type:$type,label:$variant_label,passed:$passed,hook_health_exit_code:$hook_health_exit_code,hud_suite_exit_code:$hud_suite_exit_code,exit_code:$exit_code}'
  return "$status"
}

emit_metadata
if [[ "$MODE" == real-tmux-tests ]]; then
  run_real_tmux_tests
  exit
fi
IFS=',' read -r -a CASE_LIST <<< "$CASES"
for count in "${CASE_LIST[@]}"; do
  [[ "$count" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid session count: $count" >&2; exit 2; }
  if [[ "$MODE" == cpu ]]; then
    run_cpu_case "$count"
  else
    run_diagnostic_case "$count"
  fi
done
