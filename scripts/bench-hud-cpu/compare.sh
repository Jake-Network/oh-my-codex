#!/usr/bin/env bash
set -euo pipefail

BASELINE_REPO=
FIXED_REPO=
RESULTS_DIR="$(pwd)/hud-cpu-results"
IMAGE=omx-hud-cpu-bench
CASES=1,6
WARMUP_SECONDS=10
MEASURE_SECONDS=30
REPEATS=3
DIAGNOSTIC_SECONDS=15
CPUS=2
UBUNTU_VERSION=24.04
TMUX_VERSION=apt
RUN_REAL_TMUX_TESTS=1
PIDS_LIMIT=512
CASE_TIMEOUT_SECONDS=600
REQUIRED_FAILURE=0

usage() {
  cat <<'EOF'
Usage: compare.sh --baseline-repo PATH --fixed-repo PATH [options]

Options:
  --results-dir PATH
  --cases 1,6 (optional: 1,6,19)
  --warmup-seconds N
  --measure-seconds N
  --repeats N
  --diagnostic-seconds N
  --cpus N
  --image NAME
  --ubuntu-version VERSION
  --tmux-version apt|VERSION
  --skip-real-tmux-tests
  --pids-limit N
  --case-timeout-seconds N
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline-repo) BASELINE_REPO=$2; shift 2 ;;
    --fixed-repo) FIXED_REPO=$2; shift 2 ;;
    --results-dir) RESULTS_DIR=$2; shift 2 ;;
    --cases) CASES=$2; shift 2 ;;
    --warmup-seconds) WARMUP_SECONDS=$2; shift 2 ;;
    --measure-seconds) MEASURE_SECONDS=$2; shift 2 ;;
    --repeats) REPEATS=$2; shift 2 ;;
    --diagnostic-seconds) DIAGNOSTIC_SECONDS=$2; shift 2 ;;
    --cpus) CPUS=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    --ubuntu-version) UBUNTU_VERSION=$2; shift 2 ;;
    --tmux-version) TMUX_VERSION=$2; shift 2 ;;
    --skip-real-tmux-tests) RUN_REAL_TMUX_TESTS=0; shift ;;
    --pids-limit) PIDS_LIMIT=$2; shift 2 ;;
    --case-timeout-seconds) CASE_TIMEOUT_SECONDS=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$BASELINE_REPO" && -d "$BASELINE_REPO" ]] || { echo "--baseline-repo must name a repository" >&2; exit 2; }
[[ -n "$FIXED_REPO" && -d "$FIXED_REPO" ]] || { echo "--fixed-repo must name a repository" >&2; exit 2; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

BASELINE_REPO=$(cd "$BASELINE_REPO" && pwd)
FIXED_REPO=$(cd "$FIXED_REPO" && pwd)
mkdir -p "$RESULTS_DIR"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
docker build \
  --build-arg "UBUNTU_VERSION=$UBUNTU_VERSION" \
  --build-arg "TMUX_VERSION=$TMUX_VERSION" \
  -t "$IMAGE" "$SCRIPT_DIR"

run_variant_case() {
  local label=$1
  local repo=$2
  local mode=$3
  local count=$4
  local output="$RESULTS_DIR/$label-$mode.jsonl"
  local case_output="$RESULTS_DIR/.$label-$mode-$count.case.jsonl"
  local case_error="$RESULTS_DIR/.$label-$mode-$count.case.stderr"
  local timeout_marker="$RESULTS_DIR/.$label-$mode-$count.timeout"
  local container_name="omx-hud-bench-$label-$mode-$count-$$"
  local revision docker_pid watchdog_pid killer_pid status reason attempt
  local require_hook_options=1
  [[ "$label" == baseline ]] && require_hook_options=0
  revision=$(git -C "$repo" rev-parse HEAD)
  rm -f "$case_output" "$case_error" "$timeout_marker"

  set +e
  docker run --rm --name "$container_name" --cpus "$CPUS" --pids-limit "$PIDS_LIMIT" \
    -e "BENCH_PIDS_LIMIT=$PIDS_LIMIT" \
    --mount "type=bind,src=$repo,dst=/repo,readonly" \
    "$IMAGE" \
    --mode "$mode" \
    --label "$label" \
    --source-revision "$revision" \
    --require-hook-options "$require_hook_options" \
    --cases "$count" \
    --warmup-seconds "$WARMUP_SECONDS" \
    --measure-seconds "$MEASURE_SECONDS" \
    --repeats "$REPEATS" \
    --diagnostic-seconds "$DIAGNOSTIC_SECONDS" \
    > "$case_output" 2> "$case_error" &
  docker_pid=$!
  (
    sleep "$CASE_TIMEOUT_SECONDS"
    : > "$timeout_marker"
    docker kill "$container_name" >/dev/null 2>&1 &
    killer_pid=$!
    for ((attempt = 1; attempt <= 50; attempt += 1)); do
      kill -0 "$killer_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill "$killer_pid" >/dev/null 2>&1 || true
    kill -TERM "$docker_pid" >/dev/null 2>&1 || true
  ) &
  watchdog_pid=$!
  wait "$docker_pid"
  status=$?
  kill "$watchdog_pid" >/dev/null 2>&1 || true
  wait "$watchdog_pid" 2>/dev/null || true
  if [[ ! -f "$timeout_marker" ]]; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  fi
  set -e

  [[ -s "$case_error" ]] && cat "$case_error" >&2
  if [[ "$status" == 0 && -s "$case_output" ]]; then
    tee -a "$output" < "$case_output"
  fi
  if [[ "$status" != 0 ]]; then
    reason=container_exit
    grep -Fq 'PID limit was reached' "$case_error" && reason=pids_limit
    [[ -f "$timeout_marker" ]] && reason=external_timeout
    if [[ -s "$case_output" ]]; then
      mv "$case_output" "$RESULTS_DIR/$label-$mode-$count-failed-raw.jsonl"
    fi
    jq -cn \
      --arg type invalid \
      --arg variant_label "$label" \
      --arg mode "$mode" \
      --arg reason "$reason" \
      --argjson sessions "$count" \
      --argjson exit_code "$status" \
      --argjson pids_limit "$PIDS_LIMIT" \
      '{type:$type,label:$variant_label,mode:$mode,sessions:$sessions,reason:$reason,exit_code:$exit_code,pids_limit:$pids_limit}' \
      | tee -a "$output"
    if [[ "$count" == 1 || "$count" == 6 || "$mode" == real-tmux-tests ]]; then
      REQUIRED_FAILURE=1
    fi
  fi
  rm -f "$case_output" "$case_error" "$timeout_marker"
}

IFS=',' read -r -a CASE_LIST <<< "$CASES"
for label in baseline fixed; do
  if [[ "$label" == baseline ]]; then repo=$BASELINE_REPO; else repo=$FIXED_REPO; fi
  for mode in cpu diagnostic; do
    : > "$RESULTS_DIR/$label-$mode.jsonl"
    for count in "${CASE_LIST[@]}"; do
      run_variant_case "$label" "$repo" "$mode" "$count"
    done
  done
done
if [[ "$RUN_REAL_TMUX_TESTS" == 1 ]]; then
  : > "$RESULTS_DIR/baseline-real-tmux-tests.jsonl"
  : > "$RESULTS_DIR/fixed-real-tmux-tests.jsonl"
  run_variant_case baseline "$BASELINE_REPO" real-tmux-tests 1
  run_variant_case fixed "$FIXED_REPO" real-tmux-tests 1
fi

if [[ "$REQUIRED_FAILURE" == 1 ]]; then
  echo "A required 1-session, 6-session, or real-tmux case was invalid" >&2
  exit 1
fi

for label in baseline fixed; do
  jq -e -s '
    [.[] | select(.type == "metadata")] as $records
    | ($records | length) > 0
      and ($records | map(.source_hash) | unique | length) == 1
      and ($records | map(.runtime_hash) | unique | length) == 1
      and ($records | map(.commit) | unique | length) == 1
      and ($records | all(.source_hash | test("^[0-9a-f]{64}$")))
      and ($records | all(.runtime_hash | test("^[0-9a-f]{64}$")))
  ' "$RESULTS_DIR/$label-cpu.jsonl" "$RESULTS_DIR/$label-diagnostic.jsonl" >/dev/null || {
      echo "Inconsistent source or runtime identity for $label" >&2
      exit 1
    }
  for count in 1 6; do
    [[ ",${CASES}," == *",${count},"* ]] || continue
    jq -e -s --argjson sessions "$count" --argjson repeats "$REPEATS" '
      [.[] | select(.type == "cpu" and .sessions == $sessions)] as $samples
      | ($samples | length) == $repeats
        and ($samples | map(.repeat) | sort) == [range(1; $repeats + 1)]
        and ($samples | all(.one_core_percent >= 0 and .pids_max_events >= 0))
    ' "$RESULTS_DIR/$label-cpu.jsonl" >/dev/null || {
      echo "Invalid CPU samples for $label with $count sessions" >&2
      exit 1
    }
    jq -e -s --argjson sessions "$count" '
      [.[] | select(.type == "diagnostic" and .sessions == $sessions)] as $records
      | ($records | length) == 1 and $records[0].live_watchers == $sessions
    ' "$RESULTS_DIR/$label-diagnostic.jsonl" >/dev/null || {
      echo "Invalid diagnostic sample for $label with $count sessions" >&2
      exit 1
    }
  done
done

jq -s '
  [ .[] | select(.type == "cpu") ]
  | group_by([.label, .sessions])
  | map({
      label: .[0].label,
      sessions: .[0].sessions,
      samples: length,
      mean_one_core_percent: ((map(.one_core_percent) | add) / length),
      median_one_core_percent: (map(.one_core_percent) | sort | .[(length / 2 | floor)]),
      min_one_core_percent: (map(.one_core_percent) | min),
      max_one_core_percent: (map(.one_core_percent) | max)
    })
' "$RESULTS_DIR"/*-cpu.jsonl > "$RESULTS_DIR/cpu-summary.json"

jq -s '[ .[] | select(.type == "diagnostic") ]' \
  "$RESULTS_DIR"/*-diagnostic.jsonl > "$RESULTS_DIR/diagnostic-summary.json"

printf 'CPU summary: %s\n' "$RESULTS_DIR/cpu-summary.json"
printf 'Diagnostic summary: %s\n' "$RESULTS_DIR/diagnostic-summary.json"
if [[ "$RUN_REAL_TMUX_TESTS" == 1 ]]; then
  printf 'Real-tmux test results: %s\n' "$RESULTS_DIR/{baseline,fixed}-real-tmux-tests.jsonl"
fi
