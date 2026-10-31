#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args[0] !== '--package-root' || !args[1] || !['--mcp', '--cli'].includes(args[2])) {
  throw new Error('Usage: node tools/oracle/entry.mjs --package-root <Oracle package root> --mcp | --cli [Oracle arguments]');
}
const root = realpathSync(args[1]);
const mode = args[2];
if (mode === '--mcp' && args.length !== 3) throw new Error('ORACLE_MCP_EXTRA_ARGUMENTS');
process.env.CE_ORACLE_PACKAGE_ROOT = root;
// Descendant detached workers use the same pinned patch. Discard inherited options.
process.env.NODE_OPTIONS = '--import=' + new URL('./register.mjs', import.meta.url).href;
await import('./register.mjs');
const bin = resolve(root, 'dist/bin/' + (mode === '--mcp' ? 'oracle-mcp.js' : 'oracle-cli.js'));
process.argv = [process.execPath, bin, ...args.slice(3)];
await import(pathToFileURL(bin).href);
