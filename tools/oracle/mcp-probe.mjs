/** Offline capability/dry-run smoke only. Never creates a browser or a generation. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const [packageRoot, output] = process.argv.slice(2);
if (!packageRoot || !output) throw Error('Usage: node tools/oracle/mcp-probe.mjs <packageRoot> <evidence.json>');
const isolated = await mkdtemp(join(tmpdir(), 'ce-oracle-probe-'));
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./entry.mjs', import.meta.url)), '--package-root', resolve(packageRoot), '--mcp'], env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: isolated, ORACLE_HOME_DIR: join(isolated,'state'), DOTENV_CONFIG_PATH: join(isolated,'no-env') }, stderr:'pipe' });
const client = new Client({name:'creative-engine-oracle-offline-probe',version:'1.0.0'});
try {
  await client.connect(transport);
  const available = await client.listTools();
  const result = await client.callTool({ name:'chatgpt_image', arguments:{ prompt:'SYNTHETIC OFFLINE DRY RUN ONLY: teal organizer concept', outputPath:join(isolated,'state','generated','dry-run.png'), browserModelStrategy:'current', browserArchive:'never', browserKeepBrowser:true, dryRun:true } });
  if (result.isError) {
    await writeFile(output,JSON.stringify({state:'failed',api_requests:0,browser_requests:0,result},null,2)+'\n');
    throw Error('ORACLE_MCP_DRY_RUN_FAILED');
  }
  await writeFile(output,JSON.stringify({state:'passed',api_requests:0,browser_requests:0,tools:available.tools.map(t=>t.name),result},null,2)+'\n');
  console.log(JSON.stringify({state:'passed',output,api_requests:0,browser_requests:0}));
} finally { await client.close(); await rm(isolated,{recursive:true,force:true}); }
