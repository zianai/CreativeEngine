/** Single-host, quiesced backup/restore. No cloud or shared database dependency. */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { hash } from './files.js';

function files(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('SYMLINK_REJECTED');
    if (stat.isDirectory()) return files(root, path);
    if (!stat.isFile()) throw new Error('NONREGULAR_FILE');
    return [relative(root, path)];
  });
}
function safePath(root: string, name: string) {
  if (isAbsolute(name) || name.split(/[\\/]/).some((p) => p === '..' || p === ''))
    throw new Error('UNSAFE_BACKUP_PATH');
  const p = resolve(root, name);
  if (!p.startsWith(resolve(root) + sep)) throw new Error('UNSAFE_BACKUP_PATH');
  return p;
}
export async function backupWorkspace(source: string, destination: string) {
  source = resolve(source);
  destination = resolve(destination);
  if (existsSync(destination) || destination.startsWith(source + sep))
    throw new Error('NEW_DESTINATION_REQUIRED');
  const db = new DatabaseSync(join(source, 'creative.sqlite'), { readOnly: true });
  try {
    if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running','qa_pending') LIMIT 1").get())
      throw new Error('STOP_WRITERS_AND_DRAIN_REQUIRED');
    const changes = db.prepare('PRAGMA data_version').get();
    const entries = files(source).filter(
      (f) => !['creative.sqlite', 'creative.sqlite-wal', 'creative.sqlite-shm'].includes(f),
    );
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const file of entries) {
      const dest = safePath(destination, file);
      mkdirSync(resolve(dest, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, file), dest);
    }
    await backup(db, join(destination, 'creative.sqlite'));
    // Writer processes must remain stopped. Detect changes rather than accepting a mixed snapshot.
    if (JSON.stringify(changes) !== JSON.stringify(db.prepare('PRAGMA data_version').get()))
      throw new Error('CONCURRENT_WRITER');
    if (
      JSON.stringify(entries) !==
      JSON.stringify(
        files(source).filter(
          (f) => !['creative.sqlite', 'creative.sqlite-wal', 'creative.sqlite-shm'].includes(f),
        ),
      )
    )
      throw new Error('CONCURRENT_FILE_WRITE');
    for (const file of entries)
      if (hash(readFileSync(join(source, file))) !== hash(readFileSync(join(destination, file))))
        throw new Error('CONCURRENT_FILE_WRITE');
    const manifest = {
      schema_version: '1.0.0',
      source_root: source,
      created_at: new Date().toISOString(),
      topology: 'single_host_quiesced',
      files: files(destination).map((name) => ({
        name,
        sha256: hash(readFileSync(join(destination, name))),
      })),
    };
    writeFileSync(join(destination, 'backup-manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    return manifest;
  } catch (error) {
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    db.close();
  }
}
export function restoreWorkspace(snapshot: string, destination: string) {
  snapshot = resolve(snapshot);
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error('NEW_DESTINATION_REQUIRED');
  const manifest = JSON.parse(readFileSync(join(snapshot, 'backup-manifest.json'), 'utf8'));
  if (
    manifest.schema_version !== '1.0.0' ||
    !isAbsolute(manifest.source_root) ||
    !Array.isArray(manifest.files)
  )
    throw new Error('INVALID_BACKUP');
  const declared = new Set<string>();
  for (const f of manifest.files) {
    const path = safePath(snapshot, f.name);
    if (declared.has(f.name)) throw new Error('DUPLICATE_BACKUP_FILE');
    declared.add(f.name);
    if (lstatSync(path).isSymbolicLink() || hash(readFileSync(path)) !== f.sha256)
      throw new Error('BACKUP_HASH_MISMATCH');
  }
  if (!declared.has('creative.sqlite')) throw new Error('MISSING_DATABASE');
  if (files(snapshot).some((name) => name !== 'backup-manifest.json' && !declared.has(name)))
    throw new Error('UNDECLARED_BACKUP_FILE');
  const relocate = (value: any, key = ''): any => {
    if (typeof value === 'string' && key === 'path' && value.startsWith(manifest.source_root + sep))
      return join(destination, relative(manifest.source_root, value));
    if (Array.isArray(value)) return value.map((v) => relocate(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v, k)]));
    return value;
  };
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  try {
    for (const f of manifest.files) {
      const target = safePath(destination, f.name);
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(join(snapshot, f.name), target);
      if (f.name.endsWith('.json'))
        writeFileSync(target, JSON.stringify(relocate(JSON.parse(readFileSync(target, 'utf8')))), {
          mode: 0o600,
        });
    }
    const db = new DatabaseSync(join(destination, 'creative.sqlite'));
    try {
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new Error('SQLITE_INTEGRITY');
      db.exec('BEGIN IMMEDIATE');
      for (const table of ['entities', 'jobs'])
        for (const row of db.prepare(`SELECT rowid,data FROM ${table}`).all())
          db.prepare(`UPDATE ${table} SET data=? WHERE rowid=?`).run(
            JSON.stringify(relocate(JSON.parse(String(row.data)))),
            row.rowid!,
          );
      db.exec('COMMIT');
      for (const row of db.prepare("SELECT data FROM entities WHERE kind IN ('asset','export')").all()) {
        const a = JSON.parse(String(row.data));
        if (a.sha256 && hash(readFileSync(a.path)) !== a.sha256) throw new Error('RESTORED_ASSET_HASH');
      }
    } finally {
      db.close();
    }
    return {
      status: 'restored',
      topology: 'single_host',
      file_count: manifest.files.length,
      source_manifest_sha256: hash(readFileSync(join(snapshot, 'backup-manifest.json'))),
      relocated_paths: true,
      multihost: 'not_tested',
    };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
