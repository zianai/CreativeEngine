import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { containedFile, ReceiptStore, validateRequest, validatedRaster, writeRaster } from '../files.js';
import { ProviderError, type ImageProvider, type ProviderRequest, type ProviderResult } from '../types.js';
export interface OracleConnection {
  listTools(): Promise<{ tools: { name: string; inputSchema?: Record<string, unknown> }[] }>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;
  close?(): Promise<void>;
}
export interface OracleConfig {
  command?: string;
  args?: string[];
  generatedRoot?: string;
  stateDir?: string;
  enabled?: boolean;
  connection?: OracleConnection;
  timeoutMs?: number;
}
export class OracleProvider implements ImageProvider {
  readonly id = 'oracle';
  private receipts: ReceiptStore;
  private connection?: OracleConnection;
  private config: OracleConfig;
  private probed = false;
  private generatedRoot: string;
  constructor(config: OracleConfig = {}) {
    this.config = config;
    this.connection = config.connection;
    this.generatedRoot =
      config.generatedRoot ??
      path.join(process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), '.oracle'), 'generated');
    this.receipts = new ReceiptStore(
      config.stateDir ??
        path.resolve(process.env.CREATIVE_DATA_DIR ?? '.creative-engine', 'provider-receipts', 'oracle'),
    );
  }
  capabilities() {
    return {
      generate: true,
      edit: true,
      exactSize: false,
      paid: true,
      maxConcurrency: 1,
      batch: false,
      unattended: false,
      cancellation: false,
    };
  }
  configuration() {
    const command = this.config.command ?? process.env.ORACLE_MCP_COMMAND ?? 'oracle-mcp';
    const args = this.config.args ?? process.env.ORACLE_MCP_ARGS ?? [];
    return {
      version: 'chatgpt_image-contract-2026-10-29',
      enabled:
        Boolean(this.config.connection) || (this.config.enabled ?? process.env.ORACLE_ENABLED === 'true'),
      transport_sha256: createHash('sha256')
        .update(JSON.stringify({ command, args, generatedRoot: this.generatedRoot }))
        .digest('hex'),
      attended_only: true,
      external_browser_config: 'operator_verified',
    };
  }
  estimateCost(_req: ProviderRequest) {
    return 0;
  }
  private async connect(): Promise<OracleConnection> {
    if (this.connection) return this.connection;
    if (!(this.config.enabled ?? process.env.ORACLE_ENABLED === 'true'))
      throw new ProviderError(
        'NOT_CONFIGURED',
        'Oracle is disabled. Enable it only for attended, authorized use.',
      );
    const command = this.config.command ?? process.env.ORACLE_MCP_COMMAND ?? 'oracle-mcp';
    const args =
      this.config.args ?? (process.env.ORACLE_MCP_ARGS ? JSON.parse(process.env.ORACLE_MCP_ARGS) : []);
    if (!Array.isArray(args) || args.some((x) => typeof x !== 'string'))
      throw new ProviderError('CONFIGURATION', 'Oracle MCP arguments must be a JSON string array.');
    const client = new Client({ name: 'creative-engine-oracle', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({ command, args, stderr: 'ignore' });
    try {
      await client.connect(transport);
    } catch {
      await transport.close().catch(() => {});
      throw new ProviderError(
        'ORACLE_UNAVAILABLE',
        'Could not connect to the configured Oracle MCP process.',
      );
    }
    this.connection = {
      listTools: () => client.listTools(),
      callTool: (input, options) =>
        client.callTool(input, undefined, {
          signal: options?.signal,
          timeout: options?.timeout ?? 180_000,
        }) as Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>,
      close: () => client.close(),
    };
    return this.connection;
  }
  private async probe() {
    if (this.probed) return;
    const connection = await this.connect(),
      tools = await connection.listTools(),
      tool = tools.tools.find((x) => x.name === 'chatgpt_image');
    const properties = tool?.inputSchema?.properties as Record<string, unknown> | undefined;
    if (!tool || !properties?.prompt || !properties?.files || !properties?.aspectRatio)
      throw new ProviderError(
        'UNSUPPORTED_CAPABILITY',
        'Oracle server does not expose the verified chatgpt_image input contract.',
      );
    this.probed = true;
  }
  async healthCheck(): Promise<Record<string, unknown>> {
    try {
      await this.probe();
      return {
        id: this.id,
        available: true,
        live_verified: false,
        tool: 'chatgpt_image',
        attended_only: true,
        capabilities: this.capabilities(),
      };
    } catch (e) {
      return {
        id: this.id,
        available: false,
        live_verified: false,
        reason: e instanceof ProviderError ? e.code : 'ORACLE_UNAVAILABLE',
        capabilities: this.capabilities(),
      };
    }
  }
  async generate(req: ProviderRequest) {
    return this.execute(req, false);
  }
  async edit(req: ProviderRequest) {
    if (!req.referencePaths.length)
      throw new ProviderError('REFERENCE_REQUIRED', 'Oracle edits require approved reference images.');
    return this.execute(req, true);
  }
  private async execute(req: ProviderRequest, editing: boolean): Promise<ProviderResult> {
    validateRequest(req);
    const previous = await this.getResult(req.attemptId);
    if (previous) return previous;
    await this.probe();
    for (const file of req.referencePaths) await validatedRaster(file);
    let response: { isError?: boolean; structuredContent?: Record<string, unknown> };
    try {
      response = await (
        await this.connect()
      ).callTool(
        {
          name: 'chatgpt_image',
          arguments: {
            prompt: req.prompt,
            files: req.referencePaths,
            aspectRatio: `${req.width}:${req.height}`,
            slug: req.attemptId,
            ...(req.model ? { model: req.model } : {}),
          },
        },
        { signal: req.signal, timeout: this.config.timeoutMs ?? 180_000 },
      );
    } catch {
      throw new ProviderError(
        'ORACLE_UNCERTAIN',
        'Oracle request may have reached the browser; inspect its session before retrying.',
        { uncertain: true },
      );
    }
    const data = response.structuredContent;
    if (response.isError || !data)
      throw new ProviderError(
        'ORACLE_UNCERTAIN',
        'Oracle did not return a verifiable completed image; reconcile its session.',
        { uncertain: true },
      );
    const images = data.images as { path?: unknown }[] | undefined;
    if (data.dryRun || !Array.isArray(images) || typeof images[0]?.path !== 'string')
      throw new ProviderError(
        'ORACLE_NO_IMAGE',
        'Oracle returned no usable image. Session reconciliation is required.',
        { uncertain: true },
      );
    try {
      const source = await containedFile(images[0].path, this.generatedRoot),
        filename = await writeRaster(req, await readFile(source));
      const result: ProviderResult = {
        path: filename,
        provider: this.id,
        model: req.model ?? 'oracle-browser-config',
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
        costUsd: 0,
        mock: false,
        metadata: {
          mode: editing ? 'edit' : 'generate',
          cost_basis: 'subscription_cost_not_metered',
          aspect_ratio_enforcement: 'prompt_only',
          requested_size: [req.width, req.height],
        },
      };
      await this.receipts.save(req.attemptId, result);
      return result;
    } catch (e) {
      if (e instanceof ProviderError) throw new ProviderError(e.code, e.message, { uncertain: true });
      throw new ProviderError(
        'ORACLE_INGESTION_UNCERTAIN',
        'Oracle image ingestion failed after browser execution.',
        { uncertain: true },
      );
    }
  }
  getResult(id: string) {
    return this.receipts.load(id);
  }
  async close() {
    await this.connection?.close?.();
    this.connection = undefined;
    this.probed = false;
  }
}
