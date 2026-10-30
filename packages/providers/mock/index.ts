import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { composeImage } from '../../composer/index.js';
import { ReceiptStore, validateRequest, writeRaster } from '../files.js';
import { ProviderError, type ImageProvider, type ProviderRequest, type ProviderResult } from '../types.js';
export class MockProvider implements ImageProvider {
  readonly id = 'mock';
  private receipts: ReceiptStore;
  constructor(
    stateDir = path.resolve(process.env.CREATIVE_DATA_DIR ?? '.creative-engine', 'provider-receipts', 'mock'),
  ) {
    this.receipts = new ReceiptStore(stateDir);
  }
  capabilities() {
    return {
      generate: true,
      edit: true,
      exactSize: true,
      paid: false,
      maxConcurrency: 4,
      batch: false,
      unattended: true,
    };
  }
  configuration() {
    return { version: 'deterministic-fixture-v1' };
  }
  estimateCost(_req: ProviderRequest) {
    return 0;
  }
  async healthCheck() {
    return {
      id: this.id,
      available: true,
      live_verified: false,
      mode: 'offline deterministic fixture',
      capabilities: this.capabilities(),
    };
  }
  async generate(req: ProviderRequest): Promise<ProviderResult> {
    validateRequest(req);
    const previous = await this.getResult(req.attemptId);
    if (previous) return previous;
    const seed = createHash('sha256').update(req.prompt).digest();
    const hue = (seed[0]! / 255) * 360,
      kind = seed[1]! % 3,
      cx = req.width / 2,
      cy = req.height / 2,
      scale = Math.min(req.width, req.height);
    const body =
      kind === 0
        ? `<rect x="${cx - scale * 0.18}" y="${cy - scale * 0.25}" width="${scale * 0.36}" height="${scale * 0.5}" rx="${scale * 0.08}"/>`
        : kind === 1
          ? `<ellipse cx="${cx}" cy="${cy}" rx="${scale * 0.27}" ry="${scale * 0.2}"/>`
          : `<path d="M ${cx - scale * 0.25} ${cy + scale * 0.22} L ${cx - scale * 0.08} ${cy - scale * 0.27} L ${cx + scale * 0.2} ${cy - scale * 0.14} L ${cx + scale * 0.28} ${cy + scale * 0.18} Z"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${req.width}" height="${req.height}"><rect width="100%" height="100%" fill="#f2eee6"/><path d="M 0 ${req.height * 0.8} L ${req.width} ${req.height * 0.8}" stroke="#d3cbbf"/><g fill="hsl(${hue},35%,45%)" stroke="#263b37" stroke-width="4">${body}</g><text x="${req.width * 0.07}" y="${req.height * 0.1}" font-family="sans-serif" font-size="${scale * 0.035}" fill="#243c38">MOCK · OFFLINE FIXTURE</text><rect y="${req.height * 0.88}" width="100%" height="${req.height * 0.12}" fill="#243c38"/><text x="${req.width * 0.07}" y="${req.height * 0.95}" font-family="sans-serif" font-size="${scale * 0.028}" fill="white">CONCEPT / FOR REVIEW · NOT AI GENERATED</text></svg>`;
    const output = await writeRaster(req, await sharp(Buffer.from(svg)).png().toBuffer());
    const result = {
      path: output,
      provider: this.id,
      model: 'deterministic-fixture-v1',
      costUsd: 0,
      mock: true,
      metadata: { seed: seed.toString('hex'), purpose: 'workflow verification only' },
    };
    await this.receipts.save(req.attemptId, result);
    return result;
  }
  async edit(req: ProviderRequest): Promise<ProviderResult> {
    validateRequest(req);
    if (!req.referencePaths.length)
      throw new ProviderError('REFERENCE_REQUIRED', 'Mock edit requires a reference image.');
    const previous = await this.getResult(req.attemptId);
    if (previous) return previous;
    // Fixture edits preserve source identity and visibly declare their non-generative nature.
    const filename = path.join(req.outputDir, `${req.attemptId}.png`);
    await composeImage({
      sourcePath: req.referencePaths[0]!,
      outputPath: filename,
      width: req.width,
      height: req.height,
      concept: true,
      label: 'MOCK / OFFLINE EDIT FIXTURE',
    });
    const result = {
      path: filename,
      provider: this.id,
      model: 'deterministic-fixture-v1',
      costUsd: 0,
      mock: true,
      metadata: { purpose: 'workflow verification only' },
    };
    await this.receipts.save(req.attemptId, result);
    return result;
  }
  getResult(id: string) {
    return this.receipts.load(id);
  }
}
