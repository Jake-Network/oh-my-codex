# HUD idle CPU reproduction and validation

## Source and environment

- Baseline: `official/dev` at `3ab9745e2bab24fa30a5307106ba43cbe7ea075e`.
- Fixed HUD source SHA-256: `42351c5b6c2ccb87dff7b9b39839bc82f8fea6db4cd694554deba1eb4dc8844a`.
- Ubuntu measurement: Docker Desktop on macOS, Ubuntu 24.04, tmux 3.4, Node v22.20.0, two-CPU quota, 512-process limit. Every variant and session count ran in an independent container with independent project directories.
- Ubuntu sampling: 10-second warmup followed by three 20-second CPU intervals. The cgroup `usage_usec` delta yields percent of one full CPU core. All twelve intervals retained the requested live HUD watchers and recorded `pids_max_events=0`.
- macOS host check: tmux 3.5a and Node v24.17.0, with a private tmux server for each run and 10-second warmup followed by a 20-second sample.

## Ubuntu CPU measurements

- One HUD, baseline: `54.2176%`, `43.1118%`, `43.4317%`; median `43.4317%` of one core.
- One HUD, fixed: `11.1493%`, `10.2493%`, `4.9339%`; median `10.2493%` of one core.
- Six HUDs, baseline: `200.7014%`, `201.8193%`, `201.7904%`; median `201.7904%` of one core.
- Six HUDs, fixed: `40.3738%`, `36.9371%`, `24.3696%`; median `36.9371%` of one core.

The median CPU reduction is `76.4%` with one HUD and `81.7%` with six HUDs in this two-CPU container. The six-HUD baseline reached the quota; its measured CPU cannot represent demand above two cores.

Separately instrumented 15-second diagnostic intervals recorded:

- One HUD, baseline: 15 `hud --reconcile-tmux` children, 45 `set-hook` calls, 150 tmux CLI calls, one live watcher.
- One HUD, fixed: zero reconciliation children, zero `set-hook` calls, 90 tmux CLI calls, one live watcher.
- Six HUDs, baseline: 34 reconciliation children, 132 `set-hook` calls, 438 tmux CLI calls, six live watchers.
- Six HUDs, fixed: zero reconciliation children, zero `set-hook` calls, 576 tmux CLI calls, six live watchers.

Diagnostic instrumentation was disabled during CPU sampling. The steady-state watcher still performs read-only tmux checks; the fix does not claim zero HUD CPU use.

## macOS host measurements

The tracked `mac-cpu.mjs` sampler found:

- One HUD, baseline: 20 reconciliation children and a `25.98%` one-core CPU lower bound.
- One HUD, fixed: zero reconciliation children and a `1.35%` one-core CPU lower bound.
- Six HUDs, baseline: 120 reconciliation children, 114 completed within the interval, and a `168.36%` one-core CPU lower bound.
- Six HUDs, fixed: zero reconciliation children and a `5.40%` one-core CPU lower bound.

The macOS figures include tmux-server and live-watcher CPU time plus completed reconciliation-child CPU time. Children still running when sampling ends are excluded, so the reported CPU figure is a lower bound. All requested watchers remained live throughout each run.

## Functional checks

- macOS: build, lint, no-unused check, and all 458 HUD tests passed. This includes real private-tmux split, layout, cross-window retirement, detached-session, and watch-publication tests.
- Ubuntu 22.04 / tmux 3.2a: fixed hook-health tests and all 11 real-tmux HUD split tests passed.
- Ubuntu 24.04 / tmux 3.4: fixed hook-health tests and all 11 real-tmux HUD split tests passed.
- `git diff --check`, shell syntax, and macOS sampler Node syntax passed.

Raw local measurements are in ignored `.omx/validation-cpu/docker-ubuntu24-final/` and `.omx/validation-cpu/mac-cpu-tracked.jsonl`. The benchmark and host reproduction commands are documented in `README.md`.
