import { mkdir, readFile, writeFile, rename, realpath, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ProviderError, type ProviderRequest, type ProviderResult } from './types.js';
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export function assertRasterMagic(bytes: Buffer): void {
  const png =
    bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !webp)
    throw new ProviderError('INVALID_IMAGE', 'Only PNG, JPEG and WebP raster signatures are accepted.');
}

export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id))
    throw new ProviderError('INVALID_ID', 'Invalid provider attempt identifier.');
  return id;
}
export function validateRequest(req: ProviderRequest) {
  safeId(req.attemptId);
  safeId(req.taskId);
  if (!req.prompt.trim() || req.prompt.length > 32000)
    throw new ProviderError('INVALID_PROMPT', 'Prompt must contain 1–32000 characters.');
  if (
    ![req.width, req.height].every((n) => Number.isInteger(n) && n >= 64 && n <= 3840) ||
    req.width * req.height > 8_294_400
  )
    throw new ProviderError('INVALID_SIZE', 'Image dimensions are outside supported bounds.');
  if (req.referencePaths.length > 16)
    throw new ProviderError('TOO_MANY_REFERENCES', 'At most 16 reference images are supported.');
  if (req.signal?.aborted) throw new ProviderError('CANCELLED', 'Request was cancelled before submission.');
}
export async function validatedRaster(
  file: string,
): Promise<{ width: number; height: number; format: string }> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_IMAGE_BYTES || info.size < 8)
    throw new ProviderError('INVALID_IMAGE', 'Image must be a regular file below 32 MiB.');
  assertRasterMagic(await readFile(file));
  const meta = await sharp(file, { limitInputPixels: 40_000_000, failOn: 'warning' }).metadata();
  if (
    !meta.format ||
    !['png', 'jpeg', 'webp'].includes(meta.format) ||
    !meta.width ||
    !meta.height ||
    (meta.pages ?? 1) > 1
  )
    throw new ProviderError('INVALID_IMAGE', 'Only single-frame PNG, JPEG and WebP images are accepted.');
  await sharp(file, { limitInputPixels: 40_000_000, failOn: 'warning' }).stats();
  return { width: meta.width, height: meta.height, format: meta.format };
}
export async function atomicJson(filename: string, data: unknown) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  await rename(temp, filename);
}
export async function writeRaster(req: ProviderRequest, bytes: Buffer): Promise<string> {
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 8)
    throw new ProviderError('INVALID_IMAGE', 'Provider returned an invalid image size.', { uncertain: true });
  assertRasterMagic(bytes);
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).metadata();
  if (!meta.format || !['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages ?? 1) > 1)
    throw new ProviderError('INVALID_IMAGE', 'Provider returned an unsupported image.', { uncertain: true });
  await mkdir(req.outputDir, { recursive: true });
  const filename = path.join(await realpath(req.outputDir), `${safeId(req.attemptId)}.png`);
  const output = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' })
    .rotate()
    .png()
    .toBuffer();
  await writeFile(filename, output, { flag: 'wx', mode: 0o600 });
  return filename;
}
export class ReceiptStore {
  constructor(readonly directory: string) {}
  async save(id: string, result: ProviderResult) {
    await atomicJson(path.join(this.directory, `${safeId(id)}.json`), result);
  }
  async load(id: string): Promise<ProviderResult | null> {
    try {
      const result = JSON.parse(
        await readFile(path.join(this.directory, `${safeId(id)}.json`), 'utf8'),
      ) as ProviderResult;
      await validatedRaster(result.path);
      return result;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}
export async function containedFile(file: string, root: string): Promise<string> {
  const [resolved, rootResolved] = await Promise.all([realpath(file), realpath(root)]);
  if (!resolved.startsWith(rootResolved + path.sep))
    throw new ProviderError('UNSAFE_OUTPUT', 'Provider output is outside its authorized output directory.', {
      uncertain: true,
    });
  if ((await stat(resolved)).size > MAX_IMAGE_BYTES)
    throw new ProviderError('INVALID_IMAGE', 'Provider output exceeds the image limit.', { uncertain: true });
  await validatedRaster(file);
  return resolved;
}
