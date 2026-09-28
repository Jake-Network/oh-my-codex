import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { resolveSessionPointerContext } from "../../hooks/session.js";
import {
	buildPtyScriptCommand,
	isRealTmuxAvailable,
	isRealScriptAvailable,
	type TempTmuxSessionFixture,
	withTempTmuxSession,
} from "../../team/__tests__/tmux-test-fixture.js";

const POLL_INTERVAL_MS = 50;
const TEST_TIMEOUT_MS = 10_000;

describe('owned HUD lifecycle on a private tmux server', () => {
	for (const shutdown of ['owner', 'removed-pointer', 'closed-pane', 'dead-pane'] as const) {
		it(`removes only its HUD, including remain-on-exit (${shutdown})`, async t => {
			if (!skipUnlessRealTmux(t)) return;
			const dir = await mkdtemp(join(tmpdir(), 'omx-hud-owner-'));
			const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
			try {
				await withTempTmuxSession({}, async fixture => {
					const sibling = fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.leaderPaneId, 'sleep 60']);
					const context = resolveSessionPointerContext(dir, { OMX_ROOT: dir });
					await mkdir(context.baseStateDir, { recursive: true });
					const pointer = context.sessionPath;
					await writeFile(pointer, JSON.stringify({ session_id: 'owner-test', started_at: new Date().toISOString(), cwd: dir, pid: owner.pid, tmux_pane_id: fixture.leaderPaneId }));
					const runner = join(dir, 'watch.mjs');
					const ready = join(dir, 'ready');
					await writeFile(runner, `
const { runWatchMode } = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
const { writeFile } = await import('node:fs/promises');
await runWatchMode(${JSON.stringify(dir)}, { watch: true, json: false, tmux: false }, {
  isTTY: true, isSessionAttachedFn: () => false,
  readHudConfigFn: async () => ({ preset: 'focused' }),
  readAllStateFn: async () => ({}), renderHudFn: () => 'OWNER_HUD',
  listCurrentWindowPanesFn: () => [], resizeTmuxPaneFn: () => true,
  clearTmuxPaneHistoryFn: () => true, registerHudResizeHookFn: () => true,
  reconcileTmuxHudFn: async () => {},
  runAuthorityTickFn: async () => { await writeFile(${JSON.stringify(ready)}, 'ready'); },
});
`);
					const hud = fixture.run(['split-window', '-d', '-c', dir, '-P', '-F', '#{pane_id}', '-t', fixture.leaderPaneId,
						`exec env OMX_ROOT=${quoteSh(dir)} OMX_STATE_ROOT= OMX_TEAM_STATE_ROOT= OMX_SESSION_ID=owner-test OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=${quoteSh(fixture.leaderPaneId)} ${quoteSh(process.execPath)} ${quoteSh(runner)}`]);
					fixture.run(['set-option', '-p', '-t', hud, 'remain-on-exit', 'on']);
					await waitForFile(ready);
					if (shutdown === 'removed-pointer' || shutdown === 'closed-pane') await rm(pointer);
					if (shutdown === 'closed-pane') {
						fixture.run(['kill-pane', '-t', fixture.leaderPaneId]);
					} else if (shutdown === 'dead-pane') {
						fixture.run(['set-option', '-p', '-t', fixture.leaderPaneId, 'remain-on-exit', 'on']);
						fixture.run(['respawn-pane', '-k', '-t', fixture.leaderPaneId, 'exit 0']);
					} else {
						const exited = new Promise<void>(resolve => owner.once('exit', () => resolve()));
						owner.kill('SIGKILL');
						await exited;
					}
					await waitForTmuxValue(fixture, ['list-panes', '-t', fixture.windowTarget, '-f', `#{==:#{pane_id},${hud}}`, '-F', '#{pane_id}'], '');
					assert.equal(fixture.run(['display-message', '-p', '-t', sibling, '#{pane_dead}']), '0');
					if (shutdown === 'closed-pane' || shutdown === 'dead-pane') {
						assert.equal(owner.exitCode, null, 'pane closure must work even while launcher process survives');
					} else {
						assert.equal(fixture.run(['display-message', '-p', '-t', fixture.leaderPaneId, '#{pane_dead}']), '0');
					}
				});
			} finally {
				if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
				await rm(dir, { recursive: true, force: true });
			}
		});
	}

	it('keeps failed periodic reconciliation out of tmux pane output', async t => {
		if (!skipUnlessRealTmux(t)) return;
		const dir = await mkdtemp(join(tmpdir(), "omx-hud-reconcile ' "));
		try {
			await withTempTmuxSession({}, async fixture => {
				fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', 'quiet-repair-test']);
				const commandLog = join(dir, 'tmux-commands');
				await fixture.createPathShim(dir, commandLog);
				const entry = join(dir, 'omx.js');
				const marker = join(dir, 'reconciled');
				await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2), pane:process.env.TMUX_PANE, root:process.env.OMX_ROOT})); process.exit(1);`);
				const runner = join(dir, 'watch.mjs');
				await writeFile(runner, `
const { runWatchMode } = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
process.env.OMX_ENTRY_PATH = ${JSON.stringify(entry)};
process.env.OMX_ROOT = ${JSON.stringify(dir)};
process.env.PATH = ${JSON.stringify(dir + delimiter)} + process.env.PATH;
const { execFileSync } = await import('node:child_process');
execFileSync('tmux', ['display-message', '-p', '#{socket_path}']);
await runWatchMode(${JSON.stringify(dir)}, { watch:true, json:false, tmux:false }, {
  isTTY:true, isOwnerAliveFn: async () => true, isSessionAttachedFn: () => true,
  readHudConfigFn:async () => ({preset:'focused'}), readAllStateFn:async () => ({}),
  renderHudFn:() => 'QUIET_HUD', runAuthorityTickFn:async () => {},
  resizeTmuxPaneFn:() => true,
  clearTmuxPaneHistoryFn:() => true, registerHudResizeHookFn:() => true,
});
`);
				const hud = fixture.run(['split-window', '-d', '-c', dir, '-P', '-F', '#{pane_id}', '-t', fixture.leaderPaneId,
					`exec env OMX_SESSION_ID=quiet-repair-test OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=${quoteSh(fixture.leaderPaneId)} ${quoteSh(process.execPath)} ${quoteSh(runner)} hud --watch`]);
				await waitForFile(marker);
				await new Promise(resolve => setTimeout(resolve, 1500));
				assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { args: ['hud', '--reconcile-tmux'], pane: fixture.leaderPaneId, root: dir });
				for (const pane of [hud, fixture.leaderPaneId]) {
					assert.doesNotMatch(fixture.run(['capture-pane', '-p', '-t', pane, '-S', '-']), /returned 1|reconcile-tmux|HUD watch render failed/);
				}
				// capture-pane does not include tmux's error overlay (view-mode).
				const commands = await readFile(commandLog, 'utf8');
				assert.match(commands, /display-message/);
				assert.doesNotMatch(commands, /run-shell/);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

function skipUnlessRealTmux(t: TestContext): boolean {
	if (isRealTmuxAvailable() && isRealScriptAvailable()) return true;
	assert.equal(
		process.env.CI,
		undefined,
		"CI must provide tmux and script for the real-tmux HUD refresh regression",
	);
	t.skip("tmux or script is not installed");
	return false;
}

function quoteSh(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForFile(
	path: string,
	timeoutMs = TEST_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await readFile(path, "utf8");
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForTmuxValue(
	fixture: TempTmuxSessionFixture,
	args: string[],
	expected: string,
	timeoutMs = TEST_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fixture.run(args) === expected) return;
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(
		`timed out waiting for tmux ${args.join(" ")} to equal ${JSON.stringify(expected)}`,
	);
}

function startAttachedClient(fixture: TempTmuxSessionFixture): ChildProcess {
	const command = `exec tmux -f /dev/null -L ${quoteSh(fixture.serverName)} attach-session -t ${quoteSh(fixture.sessionName)}`;
	const ptyCommand = buildPtyScriptCommand(command);
	const child = spawn(ptyCommand.executable, ptyCommand.args, {
		env: {
			...process.env,
			TMUX: undefined,
			TMUX_PANE: undefined,
			TERM: "xterm",
		},
		stdio: ["ignore", "ignore", "ignore"],
	});
	return child;
}

async function stopAttachedClient(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 1_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function buildDeterministicWatchRunner(
	modulePath: string,
	markerDir: string,
	trackDestructiveClear = true,
): string {
	return `
const { runWatchMode } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
const { writeFile } = await import('node:fs/promises');
const markerDir = ${JSON.stringify(markerDir)};
const trackDestructiveClear = ${JSON.stringify(trackDestructiveClear)};
let readCount = 0;
const empty = {
  version: 'test', gitBranch: null, ralph: null, ultrawork: null, autopilot: null,
  ralplan: null, deepInterview: null, autoresearch: null, ultraqa: null, team: null,
  metrics: null, hudNotify: null, session: null,
};
const activeUltragoal = {
  active: true, status: 'in_progress', total: 1, complete: 0, pending: 0,
  inProgress: 1, failed: 0, reviewBlocked: 0, needsUserDecision: 0, progressTotal: 1,
};
await runWatchMode(process.cwd(), { watch: true, json: false, tmux: false, preset: 'focused' }, {
  isTTY: true,
  env: process.env,
  readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'branch' }, statusLine: { preset: 'focused' } }),
  readAllStateFn: async () => {
    readCount += 1;
    const marker = 'read-' + readCount;
    await writeFile(markerDir + '/' + marker, 'started');
    if (readCount === 2) {
      while (true) {
        try {
          await import('node:fs/promises').then(({ access }) => access(markerDir + '/release'));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }
    if (readCount === 3) {
      while (true) {
        try {
          await import('node:fs/promises').then(({ access }) => access(markerDir + '/final-release'));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }
    return readCount === 2 ? { ...empty, ultragoal: activeUltragoal } : empty;
  },
  renderHudFn: () => readCount === 1
    ? 'OLD_FRAME_T1\\nOLD_FRAME_T1_TAIL'
    : readCount === 2
      ? 'NEW_FRAME_T2\\nNEW_FRAME_T2_BODY\\nNEW_FRAME_T2_TAIL'
      : 'LATEST_FRAME_T3\\nLATEST_FRAME_T3_TAIL',
  runAuthorityTickFn: async () => {},
  writeStdout: (text) => {
    if (trackDestructiveClear && text.includes('\\x1b[3J')) {
      void writeFile(markerDir + '/destructive-clear', 'unexpected');
    }
    process.stdout.write(text);
  },
  registerHudResizeHookFn: () => true,
  readHudHookHealthFn: () => 'healthy',
});
`;
}

describe("HUD watch real PTY/tmux publication", () => {
	it("publishes only the newest frame across timer ticks, 2↔3 row reflow, and detach/reattach", async (t) => {
		if (!skipUnlessRealTmux(t)) return;

		const workDir = await mkdtemp(join(tmpdir(), "omx-hud-refresh-realtmux-"));
		const markerDir = join(workDir, "markers");
		const runnerPath = join(workDir, "watch-runner.mjs");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(markerDir));

		let attachedClient: ChildProcess | undefined;
		try {
			await writeFile(
				runnerPath,
				buildDeterministicWatchRunner(
					join(process.cwd(), "dist", "hud", "index.js"),
					markerDir,
				),
			);
			await chmod(runnerPath, 0o755);

			await withTempTmuxSession(async (fixture) => {
				fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', 'refresh-test']);
				const hudCommand = `exec env OMX_SESSION_ID=refresh-test OMX_TMUX_HUD_OWNER=1 OMX_TMUX_HUD_LEADER_PANE=${quoteSh(fixture.leaderPaneId)} node ${quoteSh(runnerPath)} hud --watch`;
				const hudPaneId = fixture.run([
					"split-window",
					"-v",
					"-l",
					"2",
					"-d",
					"-P",
					"-F",
					"#{pane_id}",
					"-t",
					fixture.leaderPaneId,
					"-c",
					workDir,
					hudCommand,
				]);
				assert.match(
					hudPaneId,
					/^%\d+$/,
					"real tmux must create one HUD watcher pane",
				);
				assert.equal(
					fixture
						.run(["list-panes", "-t", fixture.leaderPaneId, "-F", "#{pane_id}"])
						.split("\n")
						.filter(Boolean).length,
					2,
				);

				await waitForFile(join(markerDir, "read-1"));
				attachedClient = startAttachedClient(fixture);
				await waitForTmuxValue(
					fixture,
					[
						"display-message",
						"-p",
						"-t",
						fixture.sessionName,
						"#{session_attached}",
					],
					"1",
				);
				await waitForFile(join(markerDir, "read-2"));

				await stopAttachedClient(attachedClient);
				attachedClient = undefined;
				await waitForTmuxValue(
					fixture,
					[
						"display-message",
						"-p",
						"-t",
						fixture.sessionName,
						"#{session_attached}",
					],
					"0",
				);
				attachedClient = startAttachedClient(fixture);
				await waitForTmuxValue(
					fixture,
					[
						"display-message",
						"-p",
						"-t",
						fixture.sessionName,
						"#{session_attached}",
					],
					"1",
				);

				await writeFile(join(markerDir, "release"), "go");
				await new Promise((resolve) => setTimeout(resolve, 300));
				assert.equal(
					fixture.run([
						"display-message",
						"-p",
						"-t",
						hudPaneId,
						"#{pane_height}",
					]),
					"3",
				);
				const afterThreeRowFrame = fixture.run([
					"capture-pane",
					"-p",
					"-t",
					hudPaneId,
					"-S",
					"-",
				]);
				assert.match(afterThreeRowFrame, /NEW_FRAME_T2/);
				assert.doesNotMatch(afterThreeRowFrame, /OLD_FRAME_T1/);
				await writeFile(join(markerDir, "final-release"), "go");
				await waitForFile(join(markerDir, "read-3"));
				await new Promise((resolve) => setTimeout(resolve, 1_200));
				assert.equal(
					fixture.run([
						"display-message",
						"-p",
						"-t",
						hudPaneId,
						"#{pane_height}",
					]),
					"2",
				);

				const visible = fixture.run(["capture-pane", "-p", "-t", hudPaneId]);
				const scrollback = fixture.run([
					"capture-pane",
					"-p",
					"-t",
					hudPaneId,
					"-S",
					"-",
				]);
				assert.match(visible, /LATEST_FRAME_T3/);
				assert.doesNotMatch(visible, /OLD_FRAME_T1|NEW_FRAME_T2/);
				assert.doesNotMatch(scrollback, /OLD_FRAME_T1|NEW_FRAME_T2/);
				assert.match(scrollback, /LATEST_FRAME_T3/);

				const paneRows = fixture
					.run(["list-panes", "-t", fixture.leaderPaneId, "-F", "#{pane_id}"])
					.split("\n")
					.filter(Boolean);
				assert.equal(
					paneRows.length,
					2,
					"the regression must keep exactly one leader and one HUD watcher",
				);
			});
		} finally {
			if (attachedClient) await stopAttachedClient(attachedClient);
			await rm(workDir, { recursive: true, force: true });
		}
	});

	it("preserves user scrollback for a non-owned tmux watch pane", async (t) => {
		if (!skipUnlessRealTmux(t)) return;

		const workDir = await mkdtemp(
			join(tmpdir(), "omx-hud-refresh-unowned-realtmux-"),
		);
		const markerDir = join(workDir, "markers");
		const runnerPath = join(workDir, "watch-runner.mjs");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(markerDir));
		let attachedClient: ChildProcess | undefined;
		try {
			await writeFile(
				runnerPath,
				buildDeterministicWatchRunner(
					join(process.cwd(), "dist", "hud", "index.js"),
					markerDir,
				),
			);
			await chmod(runnerPath, 0o755);

			await withTempTmuxSession(async (fixture) => {
				const hudCommand = `printf 'USER_SCROLLBACK_SENTINEL\\n'; exec env -u OMX_TMUX_HUD_OWNER -u OMX_TMUX_HUD_LEADER_PANE node ${quoteSh(runnerPath)}`;
				const hudPaneId = fixture.run([
					"split-window",
					"-v",
					"-l",
					"2",
					"-d",
					"-P",
					"-F",
					"#{pane_id}",
					"-t",
					fixture.leaderPaneId,
					"-c",
					workDir,
					hudCommand,
				]);
				assert.match(hudPaneId, /^%\d+$/);
				await waitForFile(join(markerDir, "read-1"));
				attachedClient = startAttachedClient(fixture);
				await waitForTmuxValue(
					fixture,
					[
						"display-message",
						"-p",
						"-t",
						fixture.sessionName,
						"#{session_attached}",
					],
					"1",
				);
				await waitForFile(join(markerDir, "read-2"));
				await writeFile(join(markerDir, "release"), "go");
				await new Promise((resolve) => setTimeout(resolve, 300));
				await writeFile(join(markerDir, "final-release"), "go");
				await waitForFile(join(markerDir, "read-3"));
				await new Promise((resolve) => setTimeout(resolve, 1_200));

				assert.equal(
					fixture.run([
						"display-message",
						"-p",
						"-t",
						hudPaneId,
						"#{pane_height}",
					]),
					"2",
				);
				const scrollback = fixture.run([
					"capture-pane",
					"-p",
					"-t",
					hudPaneId,
					"-S",
					"-",
				]);
				const visible = fixture.run(["capture-pane", "-p", "-t", hudPaneId]);
				assert.match(scrollback, /USER_SCROLLBACK_SENTINEL/);
				assert.match(visible, /LATEST_FRAME_T3/);
				await assert.rejects(readFile(join(markerDir, "destructive-clear")));
			});
		} finally {
			if (attachedClient) await stopAttachedClient(attachedClient);
			await rm(workDir, { recursive: true, force: true });
		}
	});
});
