import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, mkdir, writeFile, lstat, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { livePermission, sha } from '../../core/validation.js';
import path from 'node:path';
import os from 'node:os';
import { containedFile, ReceiptStore, validateRequest, validatedRaster, writeRaster } from '../files.js';
import { ProviderError, type ImageProvider, type ProviderRequest, type ProviderResult } from '../types.js';
/** Explicit tool intent prevents a text-only concept brief from being treated as an image edit. */
export function oracleImagePrompt(prompt: string, editing: boolean, hasReferences = false): string {
  const intent = editing
    ? 'Edit exactly one image using the attached reference image(s). Preserve the supplied constraints. Do not invent product facts or approval.'
    : hasReferences
      ? 'Generate exactly one NEW image from scratch, using the attached references only as visual constraints. Do not require an existing image target.'
      : 'Generate exactly one NEW image FROM SCRATCH. There is NO reference image and NO existing image target. Use text-to-image generation, not image editing. Follow the fictional concept brief below; do not invent product facts or approval.';
  return `${intent}\n\n${prompt}`;
}
export function oracleAspectRatio(width: number, height: number): string {
  let a = width,
    b = height;
  while (b) [a, b] = [b, a % b];
  return `${width / a}:${height / a}`;
}
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
  homeDir?: string;
  browserProfileDir?: string;
  runtimeFiles?: string[];
}
export class OracleProvider implements ImageProvider {
  readonly id = 'oracle';
  private receipts: ReceiptStore;
  private connection?: OracleConnection;
  private config: OracleConfig;
  private probed = false;
  private connectionFingerprint?: string;
  private generatedRoot: string;
  readonly model = 'oracle-browser-current-unverified';
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
      unattended: true,
      cancellation: false,
    };
  }
  private runtime() {
    const homeDir = this.config.homeDir ?? process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), '.oracle');
    const profile = this.config.browserProfileDir ?? process.env.ORACLE_BROWSER_PROFILE_DIR;
    const command = this.config.command ?? process.env.ORACLE_MCP_COMMAND ?? 'oracle-mcp';
    const args: unknown = this.config.args ?? JSON.parse(process.env.ORACLE_MCP_ARGS ?? '[]');
    const files: unknown = this.config.runtimeFiles ?? JSON.parse(process.env.ORACLE_RUNTIME_FILES ?? '[]');
    if (
      !Array.isArray(args) ||
      args.some((x) => typeof x !== 'string') ||
      !Array.isArray(files) ||
      files.some((x) => typeof x !== 'string')
    )
      throw new ProviderError(
        'CONFIGURATION',
        'Oracle arguments and runtime files must be JSON string arrays.',
      );
    return { homeDir, profile, command, args: args as string[], files: files as string[] };
  }
  configuration() {
    const runtime = this.runtime();
    return {
      version: 'chatgpt_image-authorized-worker-v2',
      enabled:
        Boolean(this.config.connection) || (this.config.enabled ?? process.env.ORACLE_ENABLED === 'true'),
      transport_sha256: sha(
        JSON.stringify({
          command: runtime.command,
          args: runtime.args,
          generatedRoot: this.generatedRoot,
          homeDir: runtime.homeDir,
          profile: runtime.profile,
          files: runtime.files.map((file) => ({ path: path.resolve(file), sha256: sha(readFileSync(file)) })),
        }),
      ),
      model_identity: this.model,
      browser_model_strategy: 'current',
      browser_thinking_time: 'medium',
      prompt_protocol: 'explicit_generate_or_edit_v1',
      aspect_ratio_protocol: 'reduced_integer_ratio_v1',
      authorization: 'fresh_pinned_one_shot_grant',
      api_cost_usd: 0,
      subscription_cost: 'unmetered',
    };
  }
  estimateCost(_req: ProviderRequest) {
    // Reservation only, not a measured browser subscription or API charge.
    return 0.25;
  }
  private async connect(): Promise<OracleConnection> {
    const fingerprint = sha(JSON.stringify(this.configuration()));
    if (this.connection) {
      if (this.connectionFingerprint && this.connectionFingerprint !== fingerprint)
        throw new ProviderError(
          'PROVIDER_CONFIGURATION_CHANGED',
          'Oracle connection belongs to an earlier configuration; close and recreate it.',
        );
      this.connectionFingerprint = fingerprint;
      return this.connection;
    }
    if (!(this.config.enabled ?? process.env.ORACLE_ENABLED === 'true'))
      throw new ProviderError(
        'NOT_CONFIGURED',
        'Oracle is disabled. Enable it only with a fresh bounded execution grant.',
      );
    const runtime = this.runtime();
    if (!runtime.profile || !path.isAbsolute(runtime.profile) || !path.isAbsolute(runtime.homeDir))
      throw new ProviderError(
        'CONFIGURATION',
        'Oracle requires an explicit existing browser profile and absolute private home.',
      );
    const client = new Client({ name: 'creative-engine-oracle', version: '1.0.0' }, { capabilities: {} });
    // No inherited API credentials, NODE_OPTIONS, tracing keys, or normal-browser cookie extraction.
    const transport = new StdioClientTransport({
      command: runtime.command,
      args: runtime.args,
      stderr: 'ignore',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: os.homedir(),
        ORACLE_HOME_DIR: runtime.homeDir,
        ORACLE_BROWSER_PROFILE_DIR: runtime.profile,
        ORACLE_ENGINE: 'browser',
        NO_PROXY: '*',
        NO_COLOR: '1',
      },
    });
    try {
      await client.connect(transport);
    } catch {
      await transport.close().catch(() => {});
      throw new ProviderError(
        'ORACLE_UNAVAILABLE',
        'Could not connect to the configured Oracle MCP process.',
      );
    }
    this.connectionFingerprint = fingerprint;
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
    const connection = await this.connect();
    if (this.probed) return;
    const tools = await connection.listTools(),
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
    if (!(this.config.enabled ?? process.env.ORACLE_ENABLED === 'true') && !this.config.connection)
      return {
        id: this.id,
        available: false,
        live_verified: false,
        reason: 'disabled',
        capabilities: this.capabilities(),
      };
    await this.probe();
    return {
      id: this.id,
      available: true,
      live_verified: false,
      reason: 'local_contract_only_fresh_grant_required',
      capabilities: this.capabilities(),
    };
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
    req = { ...req, referencePaths: [...req.referencePaths] };
    validateRequest(req);
    const previous = await this.getResult(req.attemptId);
    const refs = await Promise.all(req.referencePaths.map(async (file) => sha(await readFile(file))));
    const submittedPrompt = oracleImagePrompt(req.prompt, editing, req.referencePaths.length > 0);
    const inputHash = sha(
      JSON.stringify({
        prompt: submittedPrompt,
        width: req.width,
        height: req.height,
        refs,
        mode: editing ? 'edit' : 'generate',
      }),
    );
    if (previous) {
      if (previous.metadata?.input_hash !== inputHash)
        throw new ProviderError('ATTEMPT_ID_REUSED', 'Attempt is bound to a different request.');
      return previous;
    }
    if (req.model && req.model !== this.model)
      throw new ProviderError('UNVERIFIED_MODEL', 'Current browser model is not independently verified.');
    // Validate and reserve at the external boundary, even for direct provider callers.
    // Grant/request identity prevents retries after ambiguous outcomes or configuration drift.
    const configHash = sha(JSON.stringify(this.configuration()));
    const permit = livePermission(
      'generate_image',
      this.id,
      this.model,
      inputHash,
      configHash,
      this.estimateCost(req),
      req.attemptId,
      1,
    );
    try {
      await this.probe();
      const snapshotPaths: string[] = [];
      for (const [index, file] of req.referencePaths.entries()) {
        const bytes = await readFile(file);
        if (sha(bytes) !== refs[index])
          throw new ProviderError('REFERENCE_CHANGED', 'Reference changed after authorization.');
        const snapshotDir = path.join(this.receipts.directory, 'inputs', req.attemptId);
        await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
        const snapshot = path.join(snapshotDir, `${index}.raster`);
        await writeFile(snapshot, bytes, { flag: 'wx', mode: 0o400 });
        const format = (await validatedRaster(snapshot)).format;
        const attachment = path.join(snapshotDir, `${index}.${format}`);
        await rename(snapshot, attachment);
        snapshotPaths.push(attachment);
      }
      await mkdir(path.join(this.receipts.directory, 'submissions'), { recursive: true });
      try {
        await writeFile(
          path.join(this.receipts.directory, 'submissions', `${req.attemptId}.json`),
          JSON.stringify({
            attempt_id: req.attemptId,
            input_hash: inputHash,
            submitted_prompt_sha256: sha(submittedPrompt),
            state: 'submitted_or_unknown',
            retry_allowed: false,
          }),
          { flag: 'wx', mode: 0o600 },
        );
      } catch {
        throw new ProviderError(
          'ORACLE_UNCERTAIN',
          'Existing or unwritable submission record; reconcile without resubmitting.',
          { uncertain: true },
        );
      }
      try {
        await lstat(path.join(this.generatedRoot, `${req.attemptId}.png`));
        throw new ProviderError(
          'ORACLE_OUTPUT_EXISTS',
          'Output already exists; reconcile instead of accepting stale bytes.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // A slow local probe must not outlive revocation or change the authorized transport.
      permit.assertCurrent();
      if (sha(JSON.stringify(this.configuration())) !== configHash)
        throw new ProviderError(
          'PROVIDER_CONFIGURATION_CHANGED',
          'Oracle transport changed before submission.',
        );
      validateRequest(req);
      let response: { isError?: boolean; structuredContent?: Record<string, unknown> };
      try {
        response = await (
          await this.connect()
        ).callTool(
          {
            name: 'chatgpt_image',
            arguments: {
              prompt: submittedPrompt,
              files: snapshotPaths,
              aspectRatio: oracleAspectRatio(req.width, req.height),
              slug: req.attemptId,
              outputPath: path.join(this.generatedRoot, `${req.attemptId}.png`),
              browserModelStrategy: 'current',
              browserThinkingTime: 'medium',
              browserArchive: 'never',
              browserKeepBrowser: true,
              browserAttachments: req.referencePaths.length ? 'always' : 'never',
            },
          },
          { signal: req.signal, timeout: this.config.timeoutMs ?? 600_000 },
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
      if (
        data.dryRun ||
        !Array.isArray(images) ||
        images.length !== 1 ||
        typeof images[0]?.path !== 'string' ||
        typeof data.sessionId !== 'string' ||
        !data.sessionId ||
        data.status !== 'completed'
      )
        throw new ProviderError(
          'ORACLE_NO_IMAGE',
          'Oracle returned no usable image. Session reconciliation is required.',
          { uncertain: true },
        );
      try {
        if (path.resolve(images[0].path) !== path.resolve(this.generatedRoot, `${req.attemptId}.png`))
          throw new ProviderError(
            'ORACLE_OUTPUT_IDENTITY',
            'Returned image does not match the one-shot output path.',
            { uncertain: true },
          );
        const source = await containedFile(images[0].path, this.generatedRoot),
          filename = await writeRaster(req, await readFile(source));
        const result: ProviderResult = {
          path: filename,
          provider: this.id,
          model: this.model,
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
          costUsd: 0,
          mock: false,
          metadata: {
            mode: editing ? 'edit' : 'generate',
            cost_basis: 'api_zero_subscription_cost_not_metered',
            api_cost_usd: 0,
            actual_subscription_cost_usd: null,
            input_hash: inputHash,
            submitted_prompt_sha256: sha(submittedPrompt),
            model_verified: false,
            human_approval: false,
            aspect_ratio_enforcement: 'prompt_only',
            requested_size: [req.width, req.height],
          },
        };
        await this.receipts.save(req.attemptId, result);
        permit.complete(0, 'estimated');
        return result;
      } catch (e) {
        if (e instanceof ProviderError) throw new ProviderError(e.code, e.message, { uncertain: true });
        throw new ProviderError(
          'ORACLE_INGESTION_UNCERTAIN',
          'Oracle image ingestion failed after browser execution.',
          { uncertain: true },
        );
      }
    } catch (e) {
      permit.unknown();
      throw e;
    }
  }
  getResult(id: string) {
    return this.receipts.load(id);
  }
  async close() {
    await this.connection?.close?.();
    this.connection = undefined;
    this.probed = false;
    this.connectionFingerprint = undefined;
  }
}
