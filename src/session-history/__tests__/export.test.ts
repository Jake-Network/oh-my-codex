import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSessionHistory, renderSessionMarkdown } from '../export.js';

const timestamp = '2026-10-04T10:00:00.000Z';

async function writeTranscript(home: string, id: string, records: unknown[], archived = false): Promise<string> {
  const directory = join(home, archived ? 'archived_sessions' : 'sessions/2026/10/04');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-${id}.jsonl`);
  const meta = { type: 'session_meta', payload: { id, timestamp, cwd: '/project' } };
  await writeFile(path, [meta, ...records].map((record) => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

function message(role: string, text: string, channel?: string): unknown {
  return { type: 'response_item', timestamp, payload: { type: 'message', role, channel, content: [{ type: 'output_text', text }] } };
}

describe('exportSessionHistory', () => {
  it('exports canonical messages once, preserves repeated turns, and excludes instructions and reasoning', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-export-'));
    try {
      const path = await writeTranscript(home, 'session-a', [
        message('system', 'system secret'),
        message('developer', 'developer secret'),
        { type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } },
        message('user', 'Hello'),
        message('assistant', 'analysis secret', 'analysis'),
        { type: 'response_item', payload: { type: 'reasoning', summary: 'reasoning secret' } },
        message('assistant', '你好\n\nFinal answer', 'final'),
        { type: 'event_msg', payload: { type: 'agent_message', message: '你好\n\nFinal answer' } },
        message('user', 'Hello'),
      ]);
      const before = await readFile(path, 'utf-8');
      const document = await exportSessionHistory({ session: 'session-a', codexHomeDir: home });
      assert.equal(document.schema_version, 1);
      assert.equal(document.session_id, 'session-a');
      assert.equal(document.started_at, timestamp);
      assert.equal(document.cwd, '/project');
      assert.equal(document.archived, false);
      assert.equal(document.skipped_records, 0);
      assert.deepEqual(document.entries.map((entry) => entry.text), ['Hello', '你好\n\nFinal answer', 'Hello']);
      assert.deepEqual(document.entries.map((entry) => entry.line_number), [5, 8, 10]);
      assert.equal(document.entries[0].timestamp, timestamp);
      assert.doesNotMatch(JSON.stringify(document), /secret/);
      assert.equal(await readFile(path, 'utf-8'), before);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('supports event-only transcripts and omits tools unless requested', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-export-events-'));
    try {
      await writeTranscript(home, 'event-session', [
        { type: 'event_msg', payload: { type: 'user_message', message: 'Question' } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'call-1', channel: 'analysis', arguments: '{"cmd":"test"}' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Result' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'hidden', channel: 'analysis' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'Answer' } },
      ]);
      const ordinary = await exportSessionHistory({ session: 'event-session', codexHomeDir: home });
      assert.deepEqual(ordinary.entries.map((entry) => entry.text), ['Question', 'Answer']);
      const withTools = await exportSessionHistory({ session: 'event-session', codexHomeDir: home, includeTools: true });
      assert.deepEqual(withTools.entries.map((entry) => entry.kind), ['message', 'tool_call', 'tool_output', 'message']);
      assert.deepEqual(withTools.entries[2], {
        kind: 'tool_output', name: 'exec', call_id: 'call-1', text: 'Result', timestamp: null, line_number: 4,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('exports custom tools, structured output, and unmatched outputs without inventing names', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-export-tools-'));
    try {
      await writeTranscript(home, 'tool-session', [
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'patch', call_id: 'patch-1', input: '*** patch ***' } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: { changed: ['a.ts'] } } },
        { type: 'response_item', payload: { type: 'function_call_output', output: 'orphaned' } },
      ]);
      const document = await exportSessionHistory({ session: 'tool-session', codexHomeDir: home, includeTools: true });
      assert.equal(document.entries.length, 3);
      assert.equal(document.entries[0].text, '*** patch ***');
      assert.deepEqual(JSON.parse(document.entries[1].text), { changed: ['a.ts'] });
      const orphaned = document.entries[2];
      assert.equal(orphaned.kind, 'tool_output');
      if (orphaned.kind !== 'tool_output') throw new Error('Expected output');
      assert.equal(orphaned.call_id, null);
      assert.equal(orphaned.name, null);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('exports an archived session by a unique prefix and gives exact IDs precedence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-export-archive-'));
    try {
      await writeTranscript(home, 'abc', [message('user', 'active')]);
      await writeTranscript(home, 'abcd-archived', [message('user', 'archived')], true);
      const exact = await exportSessionHistory({ session: 'abc', codexHomeDir: home });
      assert.equal(exact.archived, false);
      assert.equal(exact.entries[0].text, 'active');
      const archived = await exportSessionHistory({ session: 'abcd', codexHomeDir: home });
      assert.equal(archived.session_id, 'abcd-archived');
      assert.equal(archived.archived, true);
      await assert.rejects(exportSessionHistory({ session: 'ab', codexHomeDir: home }), /Multiple transcripts/);
      await assert.rejects(exportSessionHistory({ session: 'absent', codexHomeDir: home }), /No local session/);
      await assert.rejects(exportSessionHistory({ session: ' ', codexHomeDir: home }), /Missing session id/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports duplicate IDs across homes and supports explicit source selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-export-homes-'));
    try {
      const first = join(root, 'first');
      const second = join(root, 'second');
      await writeTranscript(first, 'same-id', [message('user', 'first')]);
      await writeTranscript(second, 'same-id', [message('user', 'second')]);
      await assert.rejects(exportSessionHistory({ session: 'same-id', codexHomeDirs: [first, second] }), /Multiple transcripts/);
      const selected = await exportSessionHistory({ session: 'same-id', codexHomeDir: second });
      assert.equal(selected.entries[0].text, 'second');
      const repeatedHome = await exportSessionHistory({ session: 'same-id', codexHomeDirs: [first, first] });
      assert.equal(repeatedHome.entries[0].text, 'first');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores missing metadata, does not guess IDs from filenames, and tolerates a partial tail', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-export-malformed-'));
    try {
      const path = await writeTranscript(home, 'valid-id', [message('assistant', 'still readable')]);
      await writeFile(path, `${await readFile(path, 'utf-8')}\ninvalid\nnull\n{"unfinished":`, 'utf-8');
      const directory = join(home, 'sessions');
      await writeFile(join(directory, 'rollout-pretend-id.jsonl'), '{"type":"event_msg"}\n');
      await writeFile(join(directory, 'rollout-empty.jsonl'), '');
      await assert.rejects(exportSessionHistory({ session: 'pretend-id', codexHomeDir: home }), /No local session/);
      const document = await exportSessionHistory({ session: 'valid-id', codexHomeDir: home });
      assert.equal(document.skipped_records, 3);
      assert.equal(document.entries[0].text, 'still readable');
      assert.match(renderSessionMarkdown(document), /Skipped malformed records: 3/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses text and media placeholders without exporting binary data or arbitrary content fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'omx-export-media-'));
    try {
      await writeTranscript(home, 'media-session', [{
        type: 'response_item', payload: { type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'Describe this' },
          { type: 'input_image', image_url: 'data:image/png;base64,private-bytes' },
          { type: 'input_audio', data: 'private-audio' },
          { type: 'unknown', instructions: 'private-instructions' },
        ] },
      }]);
      const document = await exportSessionHistory({ session: 'media-session', codexHomeDir: home });
      assert.equal(document.entries[0].text, 'Describe this\n[Image]\n[Audio]');
      assert.doesNotMatch(JSON.stringify(document), /private-/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('discovers associated project runtime homes when no explicit home is supplied', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-export-runtime-'));
    const previousHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = join(cwd, 'empty-home');
      const runtimeHome = join(cwd, '.omx', 'runtime', 'codex-home', 'omx-runtime-export');
      await writeTranscript(runtimeHome, 'runtime-session', [message('assistant', 'runtime answer')]);
      const document = await exportSessionHistory({ session: 'runtime-session', cwd });
      assert.equal(document.entries[0].text, 'runtime answer');
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not follow symlinked rollout files', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-export-symlink-'));
    try {
      const home = join(root, 'home');
      const outside = await writeTranscript(join(root, 'outside'), 'outside-session', [message('user', 'outside')]);
      await mkdir(join(home, 'sessions'), { recursive: true });
      await symlink(outside, join(home, 'sessions', 'rollout-linked.jsonl'));
      await assert.rejects(exportSessionHistory({ session: 'outside-session', codexHomeDir: home }), /No local session/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('renderSessionMarkdown', () => {
  it('preserves message formatting and fences tool output containing backticks', () => {
    const markdown = renderSessionMarkdown({
      schema_version: 1, session_id: 'id`value', cwd: '/a\n# title', started_at: null,
      archived: true, skipped_records: 0,
      entries: [
        { kind: 'message', role: 'assistant', timestamp: null, line_number: 2, text: 'A paragraph.\n\n```js\nanswer();\n```' },
        { kind: 'tool_output', name: 'exec', call_id: 'call-1', timestamp, line_number: 3, text: '```\nquoted code\n```' },
      ],
    });
    assert.match(markdown, /Session: `` id`value ``/);
    assert.match(markdown, /Project: ` \/a # title `/);
    assert.match(markdown, /A paragraph\.\n\n```js\nanswer\(\);\n```/);
    assert.match(markdown, /````\n```\nquoted code\n```\n````/);
    assert.match(markdown, /Archived: yes/);
  });

  it('renders empty sessions explicitly', () => {
    assert.match(renderSessionMarkdown({
      schema_version: 1, session_id: 'empty', cwd: null, started_at: null,
      archived: false, skipped_records: 0, entries: [],
    }), /No exportable messages/);
  });
});
