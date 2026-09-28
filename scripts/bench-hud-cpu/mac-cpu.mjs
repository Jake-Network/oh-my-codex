import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [entryArgument, countArgument, label] = process.argv.slice(2);
const entry = resolve(entryArgument);
const count = Number(countArgument);
if (process.platform !== 'darwin') throw new Error('This benchmark requires macOS');
if (!Number.isSafeInteger(count) || count < 1 || !/^[A-Za-z0-9_-]+$/.test(label ?? '')) {
  throw new Error('Expected CLI entry, positive session count, and label');
}

const root = resolve('.omx/bench/hud-cpu-mac', `${label}-${count}-${Date.now()}-${process.pid}`);
const traceFile = join(root, 'reconcile.trace');
const preload = fileURLToPath(new URL('./mac-cpu-preload.cjs', import.meta.url));
const server = `omx-hud-cpu-${process.pid}`;
const tmuxEnv = { ...process.env, TMUX: undefined, TMUX_PANE: undefined };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function tmux(args) {
  const result = spawnSync('tmux', ['-f', '/dev/null', '-L', server, ...args], {
    encoding: 'utf8', env: tmuxEnv, timeout: 5000,
  });
  if (result.status !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

function cpuSeconds(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'time='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ps failed for ${pid}`);
  const parts = result.stdout.trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) throw new Error(`bad ps CPU time: ${result.stdout}`);
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

function watcherPids() {
  return tmux(['list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_dead}|#{pane_start_command}'])
    .split('\n')
    .filter((line) => line.includes('hud --watch'))
    .map((line) => {
      const [, pid, dead] = line.split('|', 4);
      if (dead !== '0') throw new Error(`watcher died: ${line}`);
      return Number(pid);
    });
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

mkdirSync(root, { recursive: true });
writeFileSync(traceFile, '');
try {
  for (let index = 1; index <= count; index += 1) {
    const owner = `bench-${index}`;
    const project = join(root, `project-${index}`);
    mkdirSync(join(project, '.omx', 'state'), { recursive: true });
    const session = `hud-bench-${index}`;
    const leader = tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session,
      '-x', '120', '-y', '50', '-c', project, 'sleep 86400']);
    tmux(['set-option', '-t', session, '@omx_instance_id', owner]);
    const command = [
      'exec env',
      'OMX_TMUX_HUD_OWNER=1',
      `OMX_SESSION_ID=${quote(owner)}`,
      `OMX_TMUX_HUD_LEADER_PANE=${quote(leader)}`,
      `OMX_ROOT=${quote(project)}`,
      `OMX_ENTRY_PATH=${quote(entry)}`,
      `OMX_STARTUP_CWD=${quote(process.cwd())}`,
      `NODE_OPTIONS=${quote(`--require=${preload}`)}`,
      `BENCH_RECONCILE_TRACE=${quote(traceFile)}`,
      quote(process.execPath),
      quote(entry),
      'hud --watch',
    ].join(' ');
    tmux(['split-window', '-d', '-P', '-F', '#{pane_id}', '-v', '-l', '2', '-t', leader, '-c', project, command]);
  }

  await sleep(10000);
  const beforeWatchers = watcherPids();
  if (beforeWatchers.length !== count) throw new Error(`expected ${count} watchers, got ${beforeWatchers.length}`);
  const serverPid = Number(tmux(['display-message', '-p', '-t', 'hud-bench-1', '#{pid}']));
  const pids = [serverPid, ...beforeWatchers];
  const beforeCpu = pids.map(cpuSeconds);
  writeFileSync(traceFile, '');
  const started = performance.now();
  await sleep(20000);
  const duration = (performance.now() - started) / 1000;
  const afterWatchers = watcherPids();
  if (afterWatchers.length !== count || beforeWatchers.some((pid) => !afterWatchers.includes(pid))) {
    throw new Error(`watcher set changed: ${beforeWatchers} -> ${afterWatchers}`);
  }
  const afterCpu = pids.map(cpuSeconds);
  const traceSnapshot = readFileSync(traceFile, 'utf8');
  writeFileSync(join(root, 'measurement.trace'), traceSnapshot);
  const trace = traceSnapshot.trim().split('\n').filter(Boolean);
  const startedChildren = new Set(trace.filter((line) => line.startsWith('S\t'))
    .map((line) => line.split('\t')[2]));
  const completedChildren = trace.filter((line) => line.startsWith('E\t')
    && startedChildren.has(line.split('\t')[2]));
  const childCpuUs = completedChildren.reduce((total, line) => total + Number(line.split('\t')[3]), 0);
  const liveCpuSeconds = afterCpu.reduce((total, value, index) => total + value - beforeCpu[index], 0);
  const totalCpuSeconds = liveCpuSeconds + childCpuUs / 1e6;
  process.stdout.write(`${JSON.stringify({ label, sessions: count, durationSeconds: duration,
    liveWatchers: afterWatchers.length, reconcileChildren: startedChildren.size,
    completedReconcileChildren: completedChildren.length,
    liveCpuSeconds, childCpuSeconds: childCpuUs / 1e6,
    oneCorePercentLowerBound: 100 * totalCpuSeconds / duration })}\n`);
} finally {
  spawnSync('tmux', ['-f', '/dev/null', '-L', server, 'kill-server'], { env: tmuxEnv, encoding: 'utf8' });
}
