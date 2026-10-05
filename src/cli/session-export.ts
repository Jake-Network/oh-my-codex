import { writeFile } from 'node:fs/promises';
import { exportSessionHistory, renderSessionMarkdown, type SessionExportOptions } from '../session-history/export.js';

const HELP = `Usage: omx session export <session-id> [options]

Export a local active or archived conversation using its exact id or a unique prefix.
The default format is Markdown on stdout. System/developer instructions and reasoning are excluded.

Options:
  --format <format>    markdown | json (default: markdown)
  --output <path>      Save to a new file instead of stdout; never overwrite an existing file
  --include-tools      Include tool arguments and outputs
  --codex-home <path>  Use only the supplied Codex home
  -h, --help           Show this help

Examples:
  omx session export <session-id> --output conversation.md
  omx session export <session-id> --format json --include-tools
`;

export interface ParsedSessionExportArgs {
  options: SessionExportOptions;
  format: 'markdown' | 'json';
  output?: string;
}

export function parseSessionExportArgs(args: string[]): ParsedSessionExportArgs {
  const parsed: ParsedSessionExportArgs = { options: { session: '' }, format: 'markdown' };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--include-tools') {
      parsed.options.includeTools = true;
      continue;
    }
    const separator = token.indexOf('=');
    const flag = separator < 0 ? token : token.slice(0, separator);
    if (flag === '--format' || flag === '--output' || flag === '--codex-home') {
      const value = separator < 0 ? args[++index] : token.slice(separator + 1);
      if (!value?.trim() || (separator < 0 && value.startsWith('-'))) {
        throw new Error(`Missing value after ${flag}.`);
      }
      if (flag === '--format') {
        if (value !== 'markdown' && value !== 'json') {
          throw new Error(`Invalid --format value "${value}". Expected markdown or json.`);
        }
        parsed.format = value;
      } else if (flag === '--output') parsed.output = value;
      else parsed.options.codexHomeDir = value;
      continue;
    }
    if (token.startsWith('-')) throw new Error(`Unknown option: ${token}`);
    if (parsed.options.session) throw new Error(`Unexpected positional argument for export: ${token}`);
    parsed.options.session = token.trim();
  }
  if (!parsed.options.session) throw new Error(`Missing session id.\n${HELP}`);
  return parsed;
}

export async function sessionExportCommand(args: string[]): Promise<void> {
  if (args.some((token) => token === '--help' || token === '-h') || args[0] === 'help') {
    console.log(HELP.trim());
    return;
  }
  const parsed = parseSessionExportArgs(args);
  const document = await exportSessionHistory(parsed.options);
  const content = parsed.format === 'json'
    ? `${JSON.stringify(document, null, 2)}\n`
    : renderSessionMarkdown(document);
  if (parsed.output) {
    await writeFile(parsed.output, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    console.error(`Exported session ${document.session_id} to ${parsed.output}`);
  } else {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(content, (error) => error ? reject(error) : resolve());
    });
  }
}
