export interface ProviderRequest {
  taskId: string;
  attemptId: string;
  prompt: string;
  outputDir: string;
  width: number;
  height: number;
  referencePaths: string[];
  model?: string;
  signal?: AbortSignal;
}
export interface ProviderResult {
  path: string;
  provider: string;
  model: string;
  requestId?: string;
  sessionId?: string;
  costUsd: number;
  mock: boolean;
  metadata?: Record<string, unknown>;
}
export interface ProviderCapabilities {
  generate: boolean;
  edit: boolean;
  exactSize: boolean;
  paid: boolean;
  maxConcurrency: number;
  batch?: boolean;
  unattended?: boolean;
  cancellation?: boolean;
}
export interface BatchSubmission {
  id: string;
  inputFileId: string;
  endpoint: string;
}
export interface BatchPoll {
  id: string;
  status: string;
  results: Record<string, ProviderResult>;
  errors: Record<string, string>;
}
export interface ImageProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  configuration?(): Record<string, unknown>;
  estimateCost(request: ProviderRequest): number;
  healthCheck(): Promise<Record<string, unknown>>;
  generate(request: ProviderRequest): Promise<ProviderResult>;
  edit(request: ProviderRequest): Promise<ProviderResult>;
  getResult(id: string): Promise<ProviderResult | null>;
  cancel?(id: string): Promise<void>;
  submitBatch?(requests: ProviderRequest[], mode?: 'generate' | 'edit'): Promise<BatchSubmission>;
  pollBatch?(id: string): Promise<BatchPoll>;
}
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly uncertain: boolean;
  readonly retryAfterMs?: number;
  constructor(
    public readonly code: string,
    message: string,
    options: { retryable?: boolean; uncertain?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = options.retryable ?? false;
    this.uncertain = options.uncertain ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Validate external plugin output before touching storage or accounting. */
export function validateProviderResult(value: unknown): asserts value is ProviderResult {
  const result = value as Partial<ProviderResult> | null;
  if (
    !result ||
    typeof result !== 'object' ||
    typeof result.path !== 'string' ||
    !result.path ||
    typeof result.provider !== 'string' ||
    !result.provider.trim() ||
    result.provider.length > 200 ||
    typeof result.model !== 'string' ||
    !result.model.trim() ||
    result.model.length > 200 ||
    typeof result.mock !== 'boolean' ||
    typeof result.costUsd !== 'number' ||
    !Number.isFinite(result.costUsd) ||
    result.costUsd < 0
  ) {
    throw new ProviderError(
      'INVALID_PROVIDER_RESULT',
      'Provider returned invalid result metadata or cost; reconcile the external outcome before retrying.',
      { uncertain: true },
    );
  }
}

/** Stable nonsecret snapshot suitable for plan identity and worker drift checks. */
export function providerConfiguration(provider: ImageProvider): Record<string, unknown> {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sort(item)]),
      );
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new ProviderError('INVALID_CONFIGURATION', 'Provider configuration contains nonfinite numbers.');
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    throw new ProviderError(
      'INVALID_CONFIGURATION',
      'Provider configuration must be JSON-safe and nonsecret.',
    );
  };
  return sort({
    id: provider.id,
    capabilities: provider.capabilities(),
    settings: provider.configuration?.() ?? {},
  }) as Record<string, unknown>;
}
