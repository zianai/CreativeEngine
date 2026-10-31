import { registerHooks } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { patchSource } from './patch.mjs';

const pins = JSON.parse(readFileSync(new URL('./upstream-pins.json', import.meta.url), 'utf8'));
export const helperFiles = ['entry.mjs', 'register.mjs', 'patch.mjs', 'image-dom.mjs', 'upstream-pins.json'];
export function validatePackage(packageRoot) {
  if (!packageRoot) throw new Error('CE_ORACLE_PACKAGE_ROOT_REQUIRED');
  const root = realpathSync(packageRoot);
  for (const [file, expected] of Object.entries(pins.files)) {
    const path = resolve(root, file);
    if (realpathSync(path) !== path) throw new Error('ORACLE_PINNED_FILE_SYMLINK');
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) throw new Error('ORACLE_UPSTREAM_HASH_MISMATCH:' + file);
  }
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (pkg.name !== pins.package || pkg.version !== pins.version) throw new Error('ORACLE_VERSION_MISMATCH');
  return root;
}

const root = validatePackage(process.env.CE_ORACLE_PACKAGE_ROOT);
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:')) return result;
    const path = fileURLToPath(url);
    const rel = relative(root, path);
    if (!['dist/src/browser/index.js', 'dist/src/browser/chatgptImages.js'].includes(rel)) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    if (createHash('sha256').update(source).digest('hex') !== pins.files[rel]) throw new Error('ORACLE_LOAD_HASH_MISMATCH');
    return { ...result, source: patchSource(rel, source) };
  },
});
