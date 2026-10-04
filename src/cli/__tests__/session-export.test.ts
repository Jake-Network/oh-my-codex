import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionExportArgs } from '../session-export.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function runOmx(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [join(repoRoot, 'dist/cli/omx.js'), 'session', 'export', ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CODEX_HOME: join(cwd, 'codex-home'), OMX_ROOT: '', OMX_STATE_ROOT: '' },
  });
}

async function fixture(cwd: string, text = 'Hello from a previous session'): Promise<string> {
  const directory = join(cwd, 'codex-home', 'sessions');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'rollout-export-session.jsonl');
  await writeFile(path, [
    { type: 'session_meta', payload: { id: 'export-session', cwd, timestamp: '2026-10-04T10:00:00Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'call-1', arguments: '{"cmd":"test"}' } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

describe('parseSessionExportArgs', () => {
  it('parses both flag spellings and defaults to Markdown on stdout', () => {
    assert.deepEqual(parseSessionExportArgs(['abc']), { options: { session: 'abc' }, format: 'markdown' });
    assert.deepEqual(parseSessionExportArgs(['--format=json', 'abc', '--output', 'with spaces.json', '--include-tools', '--codex-home=/codex']), {
      options: { session: 'abc', includeTools: true, codexHomeDir: '/codex' },
      format: 'json', output: 'with spaces.json',
    });
    assert.equal(parseSessionExportArgs(['abc', '--format', 'markdown', '--output=out.md', '--codex-home', '/custom']).options.codexHomeDir, '/custom');
  });

  for (const args of [[], [' '], ['abc', 'def'], ['abc', '--unknown'], ['abc', '--format=html'], ['abc', '--format'], ['abc', '--format='], ['abc', '--output'], ['abc', '--output='], ['abc', '--codex-home', '--include-tools'], ['abc', '--codex-home=']]) {
    it(`rejects invalid arguments ${JSON.stringify(args)}`, () => {
      assert.throws(() => parseSessionExportArgs(args));
    });
  }
});

describe('omx session export', () => {
  it('prints a Markdown conversation and leaves source and session state untouched', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-export-cli-'));
    try {
      const path = await fixture(cwd);
      const before = await readFile(path, 'utf-8');
      const stateRoot = join(cwd, '.omx/state');
      await mkdir(join(stateRoot, 'session.json.lock'), { recursive: true });
      const pointer = join(stateRoot, 'session.json');
      await writeFile(pointer, 'do not recover this pointer\n');
      const result = runOmx(cwd, ['export-session']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^# Session export\n/);
      assert.match(result.stdout, /## User\n\nHello from a previous session/);
      assert.doesNotMatch(result.stdout, /Tool call/);
      assert.equal(result.stderr, '');
      assert.equal(await readFile(path, 'utf-8'), before);
      assert.equal(await readFile(pointer, 'utf-8'), 'do not recover this pointer\n');
      assert.equal((await stat(join(stateRoot, 'session.json.lock'))).isDirectory(), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits complete JSON through a pipe, including messages larger than the stdout buffer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-export-cli-large-'));
    try {
      const text = 'Large message 中文\n'.repeat(20_000);
      await fixture(cwd, text);
      const result = runOmx(cwd, ['export-', '--format', 'json', '--include-tools']);
      assert.equal(result.status, 0, result.stderr);
      const document = JSON.parse(result.stdout);
      assert.equal(document.entries[0].text, text);
      assert.equal(document.entries[1].kind, 'tool_call');
      assert.equal(document.entries[1].name, 'exec');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes a new owner-only file and sends confirmation to stderr', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-export-cli-file-'));
    try {
      await fixture(cwd);
      const output = join(cwd, 'conversation with spaces.json');
      const result = runOmx(cwd, ['export-session', '--format=json', '--output', output]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Exported session export-session/);
      const document = JSON.parse(await readFile(output, 'utf-8'));
      assert.equal(document.session_id, 'export-session');
      if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite existing files, including its source transcript', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-export-cli-existing-'));
    try {
      const source = await fixture(cwd);
      const output = join(cwd, 'existing.md');
      await writeFile(output, 'keep existing output');
      for (const destination of [output, source]) {
        const before = await readFile(destination, 'utf-8');
        const result = runOmx(cwd, ['export-session', '--output', destination]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /EEXIST/);
        assert.equal(await readFile(destination, 'utf-8'), before);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite through a symlink', { skip: process.platform === 'win32' }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-export-cli-link-'));
    try {
      const source = await fixture(cwd);
      const before = await readFile(source, 'utf-8');
      const output = join(cwd, 'link.md');
      await symlink(source, output);
      const result = runOmx(cwd, ['export-session', '--output', output]);
      assert.notEqual(result.status, 0);
      assert.equal(await readFile(source, 'utf-8'), before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports missing sessions and invalid options before creating any output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-export-cli-errors-'));
    try {
      await fixture(cwd);
      const output = join(cwd, 'never-created.json');
      const missing = runOmx(cwd, ['absent', '--output', output]);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /No local session/);
      const invalid = runOmx(cwd, ['export-session', '--format=invalid', '--output', output]);
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Invalid --format/);
      await assert.rejects(stat(output), { code: 'ENOENT' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shows export help without requiring a session or accessing a supplied home', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-export-cli-help-'));
    try {
      const result = runOmx(cwd, ['--help', '--codex-home', join(cwd, 'absent')]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage: omx session export/);
      assert.match(result.stdout, /--include-tools/);
      assert.match(result.stdout, /--format/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
