import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { validatedRaster } from '../providers/files.js';
import { ProviderError } from '../providers/types.js';
export interface ComposeOptions {
  sourcePath: string;
  outputPath: string;
  width: number;
  height: number;
  background?: string;
  backgroundPath?: string;
  logoPath?: string;
  concept?: boolean;
  label?: string;
  color?: string;
  variant?: number;
}
function xml(value: string) {
  return value.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}
function dimensions(width: number, height: number) {
  if (
    ![width, height].every((n) => Number.isInteger(n) && n >= 64 && n <= 3840) ||
    width * height > 8_294_400
  )
    throw new ProviderError('INVALID_SIZE', 'Invalid composition dimensions.');
}
function hex(value: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value))
    throw new ProviderError('INVALID_COLOR', 'Colors must be six-digit hexadecimal values.');
  return value;
}
export async function composeImage(options: ComposeOptions): Promise<void> {
  const { sourcePath, outputPath, width, height, logoPath, backgroundPath, concept = false, color } = options;
  // The footer owns this identity text; a caller must not create a second text row for it.
  const label =
    concept && options.label?.trim().replace(/\s+/g, ' ').toUpperCase() === 'CONCEPT / FOR REVIEW'
      ? undefined
      : options.label;
  dimensions(width, height);
  const source = await validatedRaster(sourcePath);
  const background = hex(options.background ?? '#f5f2eb');
  if (color && !concept)
    throw new ProviderError(
      'STRICT_COLOR_CHANGE',
      'Recoloring is permitted only for explicitly authorized concept previews.',
    );
  let product = sharp(sourcePath, { limitInputPixels: 40_000_000, failOn: 'warning' }).rotate();
  if (color || backgroundPath) {
    const metadata = await product.metadata();
    if (!metadata.hasAlpha)
      throw new ProviderError(
        'CUTOUT_REQUIRED',
        'Scene composition and color previews require a supplied transparent product cutout.',
      );
    const alpha = await product.clone().ensureAlpha().extractChannel('alpha').raw().toBuffer();
    if (!alpha.some((pixel) => pixel < 255))
      throw new ProviderError(
        'CUTOUT_REQUIRED',
        'Scene composition and color previews require genuinely transparent pixels.',
      );
  }
  if (color) product = product.tint(hex(color));
  const padding = Math.round(Math.min(width, height) * 0.06);
  const footer = concept ? Math.max(42, Math.round(height * 0.075)) : 0;
  const labelHeight = label ? Math.max(36, Math.round(height * 0.06)) : 0;
  const availableWidth = width - 2 * padding,
    availableHeight = height - 2 * padding - footer - labelHeight;
  // Contain only. Cropping the source can change the apparent product or remove accessories.
  const image = await product
    .resize({ width: availableWidth, height: availableHeight, fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const overlays: OverlayOptions[] = [
    {
      input: image.data,
      left: Math.round((width - image.info.width) / 2),
      top: padding + Math.round((availableHeight - image.info.height) / 2),
    },
  ];
  if (logoPath) {
    await validatedRaster(logoPath);
    const logo = await sharp(logoPath)
      .resize({
        width: Math.max(20, Math.round(width * 0.15)),
        height: Math.max(16, Math.round(height * 0.09)),
        fit: 'inside',
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    // A separate logo tile never edits the product pixels or claims manufacturing placement.
    overlays.push({ input: logo.data, left: width - padding - logo.info.width, top: padding });
  }
  if (label) {
    const safe = xml(label.slice(0, 120)),
      font = Math.max(12, Math.round(Math.min(width, height) * 0.022));
    overlays.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${labelHeight}"><text x="${padding}" y="${Math.round(labelHeight * 0.65)}" font-family="sans-serif" font-size="${font}" fill="#20352e">${safe}</text></svg>`,
      ),
      left: 0,
      top: height - footer - labelHeight,
    });
  }
  if (concept)
    overlays.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${footer}"><rect width="100%" height="100%" fill="#263b35"/><text x="${padding}" y="${Math.round(footer * 0.64)}" font-family="sans-serif" font-size="${Math.max(12, Math.round(Math.min(width, height) * 0.025))}" fill="#ffffff">CONCEPT / FOR REVIEW</text></svg>`,
      ),
      left: 0,
      top: height - footer,
    });
  if (backgroundPath) await validatedRaster(backgroundPath);
  const canvas = backgroundPath
    ? sharp(
        await sharp(backgroundPath, { limitInputPixels: 40_000_000, failOn: 'warning' })
          .rotate()
          .resize(width, height, { fit: 'cover' })
          .ensureAlpha()
          .png()
          .toBuffer(),
      )
    : sharp({ create: { width, height, channels: 4, background } });
  const bytes = await canvas.composite(overlays).png().toBuffer();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
  void source;
}
export async function normalizeImage(
  inputPath: string,
  outputPath: string,
  width: number,
  height: number,
): Promise<void> {
  dimensions(width, height);
  await validatedRaster(inputPath);
  const bytes = await sharp(inputPath, { limitInputPixels: 40_000_000, failOn: 'warning' })
    .rotate()
    .resize(width, height, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
}
export async function labelConcept(
  inputPath: string,
  outputPath: string,
  label = 'CONCEPT / FOR REVIEW',
): Promise<void> {
  const { width, height } = await validatedRaster(inputPath);
  const band = Math.max(36, Math.round(height * 0.065));
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${band}"><rect width="100%" height="100%" fill="#263b35"/><text x="${Math.round(width * 0.03)}" y="${Math.round(band * 0.65)}" font-family="sans-serif" font-size="${Math.max(12, Math.round(band * 0.42))}" fill="white">${xml(label)}</text></svg>`,
  );
  const bytes = await sharp(inputPath)
    .extend({ bottom: band, top: 0, left: 0, right: 0, background: '#263b35' })
    .composite([{ input: svg, left: 0, top: height }])
    .png()
    .toBuffer();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
}
