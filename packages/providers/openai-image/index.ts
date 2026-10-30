import OpenAI, { toFile } from 'openai';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicJson, ReceiptStore, safeId, validateRequest, validatedRaster, writeRaster } from '../files.js';
import {
  ProviderError,
  type BatchPoll,
  type BatchSubmission,
  type ImageProvider,
  type ProviderRequest,
  type ProviderResult,
} from '../types.js';
export type OpenAIConfig = {
  apiKey?: string;
  model?: string;
  editModel?: string;
  quality?: 'low' | 'medium' | 'high';
  reservationUsd?: number;
  stateDir?: string;
  timeoutMs?: number;
  client?: OpenAI;
};
const MODEL_PATTERN = /^gpt-image-2\.5-(?:flare|sunburst)(?:-2026-09-08)?$/;
export function classifyOpenAIError(error: unknown, submitted = true): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { status?: number; name?: string; headers?: { get?: (key: string) => string | null } };
  if (e.status === 429) {
    const raw = e.headers?.get?.('retry-after') ?? '5',
      seconds = Number(raw);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
    const delay = Number.isFinite(parsed) ? parsed : 5000;
    return new ProviderError('RATE_LIMIT', 'Image provider rate limit reached.', {
      retryable: true,
      retryAfterMs: Math.min(300_000, Math.max(1000, delay)),
    });
  }
  if (e.status === 401 || e.status === 403)
    return new ProviderError('AUTHORIZATION', 'Image provider credentials or model access were rejected.');
  if (e.status === 400 || e.status === 404 || e.status === 422)
    return new ProviderError(
      'UNSUPPORTED_REQUEST',
      'Image provider rejected the requested model, capability or input.',
    );
  return new ProviderError(
    submitted ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_UNAVAILABLE',
    submitted
      ? 'The image request outcome is unknown; reconcile before retrying.'
      : 'The provider is unavailable.',
    { uncertain: submitted, retryable: !submitted },
  );
}
export function usageCost(usage: unknown, multiplier = 1): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
  if (
    !Number.isFinite(u.output_tokens) ||
    !Number.isFinite(u.input_tokens_details?.text_tokens) ||
    !Number.isFinite(u.input_tokens_details?.image_tokens)
  )
    return null;
  return Number(
    (
      ((u.input_tokens_details!.text_tokens! * 5 +
        u.input_tokens_details!.image_tokens! * 8 +
        u.output_tokens! * 30) /
        1_000_000) *
      multiplier
    ).toFixed(8),
  );
}
export class OpenAIImageProvider implements ImageProvider {
  readonly id = 'openai';
  readonly model: string;
  readonly editModel: string;
  private client?: OpenAI;
  private receipts: ReceiptStore;
  private quality: 'low' | 'medium' | 'high';
  private reservation: number;
  private stateDir: string;
  private availableModels = new Set<string>();
  constructor(config: OpenAIConfig = {}) {
    this.model = config.model ?? process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2.5-flare-2026-09-08';
    this.editModel =
      config.editModel ?? process.env.OPENAI_IMAGE_EDIT_MODEL ?? 'gpt-image-2.5-sunburst-2026-09-08';
    this.quality = config.quality ?? 'medium';
    this.reservation = config.reservationUsd ?? Number(process.env.OPENAI_IMAGE_RESERVATION_USD ?? '1');
    if (!Number.isFinite(this.reservation) || this.reservation <= 0)
      throw new ProviderError('CONFIGURATION', 'OpenAI task reservation must be positive.');
    this.stateDir =
      config.stateDir ??
      path.resolve(process.env.CREATIVE_DATA_DIR ?? '.creative-engine', 'provider-receipts', 'openai');
    this.receipts = new ReceiptStore(this.stateDir);
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    this.client =
      config.client ??
      (apiKey ? new OpenAI({ apiKey, maxRetries: 0, timeout: config.timeoutMs ?? 180_000 }) : undefined);
  }
  capabilities() {
    return {
      generate: true,
      edit: true,
      exactSize: true,
      paid: true,
      maxConcurrency: 2,
      batch: true,
      unattended: true,
      cancellation: false,
    };
  }
  configuration() {
    return {
      model: this.model,
      edit_model: this.editModel,
      quality: this.quality,
      reservation_usd: this.reservation,
      capability_profile: 'gpt-image-2.5-2026-09-08',
      pricing_version: '2026-10-29',
    };
  }
  estimateCost(req: ProviderRequest) {
    return this.reservation * Math.max(1, Math.ceil((req.width * req.height) / (1024 * 1024)));
  }
  async healthCheck(): Promise<Record<string, unknown>> {
    if (!this.client)
      return {
        id: this.id,
        available: false,
        reason: 'credentials_not_configured',
        live_verified: false,
        models: [this.model, this.editModel],
        capabilities: this.capabilities(),
      };
    try {
      await Promise.all([...new Set([this.model, this.editModel])].map((model) => this.verifyModel(model)));
      return {
        id: this.id,
        available: true,
        live_verified: false,
        model_access_verified: true,
        models: [this.model, this.editModel],
        capabilities: this.capabilities(),
      };
    } catch (e) {
      return {
        id: this.id,
        available: false,
        reason: classifyOpenAIError(e, false).code,
        live_verified: false,
        capabilities: this.capabilities(),
      };
    }
  }
  private requireClient() {
    if (!this.client)
      throw new ProviderError('NOT_CONFIGURED', 'OpenAI image credentials are not configured.');
    return this.client;
  }
  private async verifyModel(model: string) {
    if (!MODEL_PATTERN.test(model))
      throw new ProviderError(
        'UNSUPPORTED_MODEL',
        'Configured model lacks a verified Creative Engine image capability profile.',
      );
    if (!this.availableModels.has(model)) {
      try {
        await this.requireClient().models.retrieve(model);
        this.availableModels.add(model);
      } catch (e) {
        throw classifyOpenAIError(e, false);
      }
    }
  }
  private async body(req: ProviderRequest, mode: 'generate' | 'edit') {
    validateRequest(req);
    const model = req.model ?? (mode === 'edit' ? this.editModel : this.model);
    await this.verifyModel(model);
    if (
      req.width % 16 ||
      req.height % 16 ||
      req.width * req.height < 655_360 ||
      Math.max(req.width, req.height) / Math.min(req.width, req.height) > 3
    )
      throw new ProviderError(
        'UNSUPPORTED_SIZE',
        'GPT Image 2.5 requires 16-pixel increments, 655360–8294400 pixels and aspect ratio at most 3:1.',
      );
    return {
      model,
      prompt: req.prompt,
      n: 1,
      size: `${req.width}x${req.height}`,
      quality: this.quality,
      output_format: 'png' as const,
    };
  }
  async generate(req: ProviderRequest) {
    return this.execute(req, 'generate');
  }
  async edit(req: ProviderRequest) {
    return this.execute(req, 'edit');
  }
  private async execute(req: ProviderRequest, mode: 'generate' | 'edit'): Promise<ProviderResult> {
    validateRequest(req);
    const previous = await this.getResult(req.attemptId);
    if (previous) return previous;
    const client = this.requireClient(),
      body = await this.body(req, mode);
    if (mode === 'edit' && !req.referencePaths.length)
      throw new ProviderError(
        'REFERENCE_REQUIRED',
        'Image editing requires at least one approved reference.',
      );
    const images =
      mode === 'edit'
        ? await Promise.all(
            req.referencePaths.map(async (file) => {
              await validatedRaster(file);
              return toFile(await readFile(file), path.basename(file));
            }),
          )
        : [];
    let response: OpenAI.Images.ImagesResponse;
    try {
      const options = {
        signal: req.signal,
        maxRetries: 0,
        headers: { 'X-Client-Request-Id': req.attemptId },
      };
      response =
        mode === 'edit'
          ? await client.images.edit(
              { ...body, image: images } as OpenAI.Images.ImageEditParamsNonStreaming,
              options,
            )
          : await client.images.generate(body as OpenAI.Images.ImageGenerateParamsNonStreaming, options);
    } catch (e) {
      throw classifyOpenAIError(e);
    }
    try {
      return await this.ingest(req, response, body.model);
    } catch (e) {
      if (e instanceof ProviderError && e.uncertain) throw e;
      throw new ProviderError(
        'INGESTION_UNCERTAIN',
        'Provider responded but local image ingestion failed; reconcile before retrying.',
        { uncertain: true },
      );
    }
  }
  private async ingest(
    req: ProviderRequest,
    response: OpenAI.Images.ImagesResponse,
    model: string,
    multiplier = 1,
  ): Promise<ProviderResult> {
    const data = response.data?.[0]?.b64_json;
    // URLs are deliberately not fetched; prevents provider response SSRF and expiring-download ambiguity.
    if (
      !data ||
      typeof data !== 'string' ||
      data.length > 48_000_000 ||
      !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(data)
    )
      throw new ProviderError('INVALID_RESPONSE', 'Expected bounded base64 image data.', { uncertain: true });
    const filename = await writeRaster(req, Buffer.from(data, 'base64')),
      cost = usageCost(response.usage, multiplier);
    const requestId = (response as unknown as { _request_id?: string })._request_id;
    const result: ProviderResult = {
      path: filename,
      provider: this.id,
      model,
      requestId,
      costUsd: cost ?? this.estimateCost(req) * multiplier,
      mock: false,
      metadata: {
        usage: response.usage ?? null,
        cost_basis: cost === null ? 'reservation_estimate' : 'reported_usage',
        pricing_version: '2026-10-29',
        quality: this.quality,
      },
    };
    await this.receipts.save(req.attemptId, result);
    return result;
  }
  getResult(id: string) {
    return this.receipts.load(id);
  }
  async submitBatch(
    requests: ProviderRequest[],
    mode: 'generate' | 'edit' = 'generate',
  ): Promise<BatchSubmission> {
    if (!requests.length || requests.length > 100)
      throw new ProviderError('BATCH_SIZE', 'Batch adapter accepts 1–100 image requests.');
    if (new Set(requests.map((r) => r.attemptId)).size !== requests.length)
      throw new ProviderError('DUPLICATE_REQUEST', 'Batch custom ids must be unique.');
    const endpoint = mode === 'edit' ? '/v1/images/edits' : '/v1/images/generations';
    const rows = await Promise.all(
      requests.map(async (req) => {
        const body = await this.body(req, mode);
        if (mode === 'edit') {
          if (!req.referencePaths.length)
            throw new ProviderError('REFERENCE_REQUIRED', 'Batch edits need references.');
          const images = await Promise.all(
            req.referencePaths.map(async (file) => {
              const meta = await validatedRaster(file);
              return {
                image_url: `data:image/${meta.format === 'jpeg' ? 'jpeg' : meta.format};base64,${(await readFile(file)).toString('base64')}`,
              };
            }),
          );
          return { custom_id: req.attemptId, method: 'POST', url: endpoint, body: { ...body, images } };
        }
        return { custom_id: req.attemptId, method: 'POST', url: endpoint, body };
      }),
    );
    if (new Set(rows.map((r) => r.body.model)).size !== 1)
      throw new ProviderError('MIXED_MODELS', 'A remote batch must use one model.');
    const jsonl = rows.map((row) => JSON.stringify(row)).join('\n');
    if (Buffer.byteLength(jsonl) > 190_000_000)
      throw new ProviderError('BATCH_SIZE', 'Remote batch input exceeds the allowed byte limit.');
    try {
      const client = this.requireClient(),
        file = await client.files.create({
          file: await toFile(Buffer.from(jsonl), 'images.jsonl'),
          purpose: 'batch',
        });
      const batch = await client.batches.create({
        input_file_id: file.id,
        endpoint,
        completion_window: '24h',
      } as OpenAI.Batches.BatchCreateParams);
      const stored = requests.map(({ signal, ...req }) => req);
      await atomicJson(path.join(this.stateDir, `batch-${safeId(batch.id)}.json`), {
        requests: stored,
        model: rows[0]!.body.model,
      });
      return { id: batch.id, inputFileId: file.id, endpoint };
    } catch (e) {
      throw classifyOpenAIError(e);
    }
  }
  async pollBatch(id: string): Promise<BatchPoll> {
    safeId(id);
    const client = this.requireClient();
    const stored = JSON.parse(await readFile(path.join(this.stateDir, `batch-${id}.json`), 'utf8')) as {
      requests: ProviderRequest[];
      model: string;
    };
    const batch = await client.batches.retrieve(id),
      results: Record<string, ProviderResult> = {},
      errors: Record<string, string> = {};
    for (const fileId of [batch.output_file_id, batch.error_file_id]) {
      if (!fileId) continue;
      const response = await client.files.content(fileId),
        text = await response.text();
      if (Buffer.byteLength(text) > 256_000_000)
        throw new ProviderError('INVALID_RESPONSE', 'Remote batch results exceed the ingestion limit.');
      for (const line of text.split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as {
          custom_id: string;
          response?: { status_code: number; body: OpenAI.Images.ImagesResponse };
          error?: { code?: string };
        };
        const req = stored.requests.find((r) => r.attemptId === row.custom_id);
        if (!req) {
          errors[row.custom_id] = 'UNKNOWN_CUSTOM_ID';
          continue;
        }
        if (row.response?.status_code === 200) {
          try {
            results[row.custom_id] =
              (await this.getResult(req.attemptId)) ??
              (await this.ingest(req, row.response.body, stored.model, 0.5));
          } catch {
            errors[row.custom_id] = 'INGESTION_FAILED';
          }
        } else errors[row.custom_id] = row.error?.code ?? `HTTP_${row.response?.status_code ?? 'UNKNOWN'}`;
      }
    }
    return { id, status: batch.status, results, errors };
  }
  async cancelBatch(id: string) {
    await this.requireClient().batches.cancel(safeId(id));
  }
}
