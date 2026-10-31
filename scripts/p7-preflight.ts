import { readFileSync } from 'node:fs';
import { ValidationRunPolicy } from '../packages/core/validation.js';
const [file, ceiling] = process.argv.slice(2);
if (!file) throw new Error('usage: p7-preflight.ts REQUEST.json UPPER_USD');
const result = new ValidationRunPolicy().preflight(
  JSON.parse(readFileSync(file, 'utf8')),
  ceiling,
  Boolean(process.env.OPENAI_API_KEY),
);
console.log(JSON.stringify(result));
process.exitCode = result.status === 'allowed' ? 0 : 2;
