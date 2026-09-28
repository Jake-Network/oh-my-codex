# OMX HUD idle CPU benchmark

This benchmark runs real `omx hud --watch` processes in detached sessions on a private tmux server inside Ubuntu 24.04. It measures the container's cgroup CPU counter only after build, setup, and warmup have finished.

## Reproduce the issue and compare a fix

Prepare two repository directories. The baseline directory must contain the affected revision, and the fixed directory must contain the proposed change, including any uncommitted files that should be tested.

```bash
scripts/bench-hud-cpu/compare.sh \
  --baseline-repo /absolute/path/to/baseline \
  --fixed-repo /absolute/path/to/fixed \
  --results-dir "$PWD/hud-cpu-results" \
  --skip-real-tmux-tests
```

The default matrix uses 1 and 6 owned HUD sessions, a 10-second warmup, three 30-second CPU samples, and a separate 15-second diagnostic sample. Every label, mode, and session count runs in an independent container with a 600-second external watchdog, two CPUs, and a 512-process ceiling. Add `--cases 1,6,19` only for a separately monitored saturation test. A failed 19-session container cannot prevent the lower-count cases from running. Each repository is mounted read-only and copied inside its container before `npm ci` and `npm run build`, so the measured source tree is not changed.

For a short smoke run:

```bash
scripts/bench-hud-cpu/compare.sh \
  --baseline-repo /absolute/path/to/baseline \
  --fixed-repo /absolute/path/to/fixed \
  --cases 1,6 \
  --warmup-seconds 3 \
  --measure-seconds 5 \
  --repeats 1 \
  --diagnostic-seconds 5
```

## Evidence produced

`cpu-summary.json` reports the mean, minimum, and maximum CPU consumption for each session count. `one_core_percent` is calculated from the cgroup `usage_usec` delta, where `100` means one fully occupied CPU core during the sample.

`diagnostic-summary.json` reports:

- `reconcile_children`: exact `hud --reconcile-tmux` launches recorded by an instrumented OMX entrypoint;
- `set_hook_calls`: tmux `set-hook` calls recorded by an instrumented tmux executable;
- `tmux_cli_calls`: all tmux client calls made during the diagnostic interval;
- `live_watchers`: owned HUD watchers still alive at the end of the interval.

The diagnostic instrumentation is not enabled during CPU measurement. Setup and verification use `/usr/bin/tmux` directly, so their commands do not enter the diagnostic counts.

Omit `--skip-real-tmux-tests` to run `dist/hud/__tests__/tmux-split-realtmux.test.js` with `CI=1` for each source tree. TAP output is printed to stderr and a JSON pass/fail record is stored in `{baseline,fixed}-real-tmux-tests.jsonl`. A failing real-tmux test makes the comparison command fail.

## Acceptance evidence

A valid result has the requested number of `live_watchers` for every case and matching `runtime_hash` metadata for repeat runs of the same runtime source. `source_hash` also covers HUD tests. The fixed variant should have zero steady-state reconciliation children and zero steady-state `set-hook` calls after warmup. Repeated 1-session and 6-session samples are required acceptance evidence. A 19-session numeric result is valid only when its independent container finishes every sample without reaching the PID ceiling or external timeout.

Every CPU sample reads `pids.events` around the measured interval. If the process limit is reached, the run fails and emits no numeric sample for that case. The host runner records the failed case as `type: "invalid"` with its reason, preserves partial container output in `LABEL-MODE-SESSIONS-failed-raw.jsonl`, and continues. Partial measurements from an invalid case are excluded from the CPU summary. This prevents a saturated baseline from being reported as healthy and protects the Docker host from an unbounded reconciliation fork storm.

The benchmark intentionally uses independent Git repositories as each HUD's working directory. This prevents a shared `.omx/state/hud-reconcile.lock` from serializing the fault and hiding per-watcher CPU cost.

## macOS host check

Build both source trees on macOS, then run the host sampler from the fixed repository while other benchmark runs are idle:

```bash
node scripts/bench-hud-cpu/mac-cpu.mjs /absolute/path/to/baseline/dist/cli/omx.js 1 baseline
node scripts/bench-hud-cpu/mac-cpu.mjs dist/cli/omx.js 1 fixed
node scripts/bench-hud-cpu/mac-cpu.mjs /absolute/path/to/baseline/dist/cli/omx.js 6 baseline
node scripts/bench-hud-cpu/mac-cpu.mjs dist/cli/omx.js 6 fixed
```

Each run creates independent working directories and live HUD watchers on a private tmux server, waits 10 seconds, and samples for 20 seconds. It records watcher and tmux-server CPU time with `ps`, plus completed `hud --reconcile-tmux` child CPU time using `NODE_OPTIONS`. The reported `oneCorePercentLowerBound` excludes children still running when the interval ends. The trace and project fixtures remain under ignored `.omx/bench/hud-cpu-mac/` for inspection. The sampler terminates its private tmux server on exit.

## tmux version matrix

Run the complete comparison for each environment. Keep CPU conclusions within one environment; different Ubuntu and tmux builds are compatibility evidence, not paired performance samples.

- Ubuntu `22.04` with `--tmux-version apt`: expected tmux `3.2a`.
- Ubuntu `24.04` with `--tmux-version apt`: expected tmux `3.4`.
- Ubuntu `24.04` with `--tmux-version 3.5a`: tmux `3.5a` built from the upstream release archive.

Pass `--ubuntu-version 22.04` or `--tmux-version 3.5a` to `compare.sh`. Every JSONL metadata record includes the observed `tmux -V`, so a version mismatch is visible in the evidence.
