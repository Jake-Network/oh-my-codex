# HUD idle CPU reproduction and validation

## Environment and source identity

- Host: macOS Docker Desktop, Linux kernel `6.10.14-linuxkit`.
- Measurement container: Ubuntu 24.04, tmux 3.4, Node v22.20.0, two-CPU quota, 512-process limit.
- Baseline revision: `c5ad2d02d72e7646b77a0315758a6c24cd6a9f46`.
- Fixed runtime source SHA-256: `0d4d001e6323c8ff8c8b078f2ab068325a28458e0ff6b7ee9ea1cedeb26512df`.
- Each variant and session count used its own container. Builds and the 10-second warmup finished before CPU sampling. Diagnostic instrumentation was disabled during CPU sampling.
- CPU values are percentages of one full core, calculated from the cgroup `usage_usec` delta over 30 seconds. Each measured interval passed live-watcher, pane-topology, ownership, and hook verification. All twelve intervals reported `pids_max_events=0`.

## Reproduction results

- One HUD, baseline: `29.1218%`, `29.7189%`, `31.4455%`; median `29.7189%`.
- One HUD, fixed: `4.2278%`, `4.4151%`, `4.4774%`; median `4.4151%`, an `85.14%` reduction.
- Six HUDs, baseline: `200.7762%`, `200.7709%`, `201.3457%`; median `200.7762%`.
- Six HUDs, fixed: `25.9263%`, `23.4930%`, `22.3581%`; median `23.4930%`, an `88.30%` reduction.

The separately instrumented 15-second diagnostic intervals found:

- One HUD, baseline: 15 `hud --reconcile-tmux` children, 45 `set-hook` calls, 150 tmux CLI calls, one live watcher.
- One HUD, fixed: zero reconciliation children, zero `set-hook` calls, 90 tmux CLI calls, one live watcher.
- Six HUDs, baseline: 91 reconciliation children, 258 `set-hook` calls, 883 tmux CLI calls, six live watchers.
- Six HUDs, fixed: zero reconciliation children, zero `set-hook` calls, 546 tmux CLI calls, six live watchers.

The steady-state parent watcher still performs read-only tmux checks; the measurements do not assert zero HUD CPU consumption.

## Validation

- Local build, lint, no-unused check, shell syntax, Node syntax, and `git diff --check`: passed.
- Local HUD suites: 189 tests passed.
- Ubuntu 24.04 / tmux 3.4: hook-health tests 2/2 and real-tmux HUD tests 10/10 passed.
- Ubuntu 22.04 / tmux 3.2a: hook-health tests 2/2 and real-tmux HUD tests 10/10 passed with the same fixed runtime source hash.
- The 19-HUD baseline did not yield a valid CPU sample during exploratory testing. It is excluded from numeric conclusions. The benchmark makes 19 HUDs opt-in and applies a process ceiling and external watchdog.

Raw local artifacts are under `.omx/bench/hud-cpu-final-ubuntu24-tmux34-20260928-v3/` for the baseline, `.omx/bench/hud-cpu-final-runtime-0d4d001e/` for the fixed version, and `.omx/bench/hud-marker-compat-ubuntu22-tmux32a-20260928/` for tmux 3.2a compatibility. Run `compare.sh` as described in `README.md` to generate fresh JSONL data and summaries.
