import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, realpath, lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function atomicWrite(path: string, bytes: Buffer | string) {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}
export async function inside(root: string, path: string) {
  const base = await realpath(root),
    file = await realpath(path);
  if (!file.startsWith(base + sep) || !(await lstat(file)).isFile())
    throw new Error('Asset path outside storage');
  return file;
}
export async function acceptFile(root: string, input: any) {
  if (!input.authorized || !input.sensitive_data_cleared)
    throw new Error('Usage rights and sensitive-data clearance are required');
  if (
    !input.filename ||
    input.filename.includes('/') ||
    input.filename.includes('\\') ||
    input.filename.includes('\0') ||
    input.filename === '..'
  )
    throw new Error('Invalid filename');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data_base64) || input.data_base64.length > 28_000_000)
    throw new Error('Invalid or oversized base64 upload');
  const bytes = Buffer.from(input.data_base64, 'base64');
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024)
    throw new Error('Upload must be between 1 byte and 20 MiB');
  let metadata: any = {};
  let extension: string;
  if (input.kind === 'document') {
    if (bytes.subarray(0, 5).toString() === '%PDF-') extension = 'pdf';
    else if (
      /\.(txt|md|csv)$/i.test(input.filename) &&
      !bytes.includes(0) &&
      !/<\s*(svg|script|html)/i.test(bytes.toString())
    )
      extension = 'txt';
    else throw new Error('Only PDF or plain text evidence documents are accepted');
  } else {
    const raster =
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
      (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
    if (!raster) throw new Error('Only raster PNG, JPEG, WebP signatures are accepted');
    const m = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(m.format ?? '') || !m.width || !m.height || (m.pages ?? 1) > 1)
      throw new Error('Only single-frame PNG, JPEG, WebP allowed');
    if (input.kind === 'cutout' && !m.hasAlpha) throw new Error('A cutout must have an alpha channel');
    metadata = { width: m.width, height: m.height, format: m.format };
    extension = m.format === 'jpeg' ? 'jpg' : m.format!;
  }
  const dir = join(root, 'assets');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const digest = hash(bytes),
    path = resolve(dir, `${crypto.randomUUID()}.${extension}`);
  await atomicWrite(path, bytes);
  return { path, sha256: digest, ...metadata, size_bytes: bytes.length };
}
export async function inspectStored(root: string, path: string) {
  const safe = await inside(root, path);
  const bytes = await readFile(safe);
  const m = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(m.format ?? '')) throw new Error('Invalid output file');
  return {
    sha256: hash(bytes),
    width: m.width,
    height: m.height,
    format: m.format,
    size_bytes: bytes.length,
  };
}
