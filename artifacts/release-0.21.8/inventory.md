# Release inventory — 0.21.8

Frozen range: `v0.21.7..d2e91b866d540b9e2454edb1b928a56d9bd9a30c` (14 commits, 25 files changed, +1249/-51).

Frozen candidate: `d2e91b866d540b9e2454edb1b928a56d9bd9a30c`.

## Merged PRs

- [#3737](https://github.com/Yeachan-Heo/oh-my-codex/pull/3737): fix(#3736): apply platform-specific binary suffix to provided debug/release paths on Windows.
- [#3741](https://github.com/Yeachan-Heo/oh-my-codex/pull/3741): fix(#3740): replace thread fallback with readPayloadSessionId helper.
- [#3742](https://github.com/Yeachan-Heo/oh-my-codex/pull/3742): fix(#3739): support legacy v0.21.6 AGENTS.md backup path via git rev-parse.
- [#3743](https://github.com/Yeachan-Heo/oh-my-codex/pull/3743): chore: bump dev version to 0.21.8.
- [#3745](https://github.com/Yeachan-Heo/oh-my-codex/pull/3745): feat: export local sessions as Markdown or JSON format (authored by @hiSandog).
- [#3746](https://github.com/Yeachan-Heo/oh-my-codex/pull/3746): fix(#3744): make writeAtomic use syncRegularFile to handle Windows EPERM.
- [#3748](https://github.com/Yeachan-Heo/oh-my-codex/pull/3748): fix(#3747): clarify warning message for non-OMX Codex sessions.
- [#3749](https://github.com/Yeachan-Heo/oh-my-codex/pull/3749): fix(#3747): correct warning message for non-OMX Codex sessions.

## Validation evidence

See `docs/qa/release-readiness-0.21.8.md` for the full verification record: typecheck, lint, plugin mirror sync, capabilities lock verification, prompt guidance, native agents, prompt inventory, and test suite results.
