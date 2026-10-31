/** P7 operator-bound grants. No REST/MCP/Agent tool can create authority. */
import { readFileSync, existsSync, lstatSync, realpathSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../contracts/index.js';

export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const denied = (code: string): never => {
  throw new AppError(code, code, 403);
};
const micros = (value: unknown) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean')
    return denied('INVALID_PRICE_CEILING');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10000) return denied('INVALID_PRICE_CEILING');
  return Math.ceil(n * 1e6);
};
export class ValidationRunPolicy {
  constructor(
    readonly root = process.env.CREATIVE_ENGINE_P7_ROOT ?? '',
    readonly approvedSha = process.env.CREATIVE_ENGINE_P7_APPROVED_GRANT_SHA256 ?? '',
    readonly enabled = process.env.ALLOW_TEST_LIVE === 'on',
  ) {}
  private read(name: string): Buffer {
    if (!this.root || resolve(this.root) !== realpathSync(this.root)) return denied('ISOLATION_REQUIRED');
    const file = join(this.root, name),
      stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 65536)
      return denied('PRIVATE_OPERATOR_RECORD_REQUIRED');
    return readFileSync(file);
  }
  context(): any {
    return JSON.parse(this.read('context.json').toString());
  }
  /** An approved target must match before opening any existing workspace database. */
  evaluationTarget(dataRoot: string, batchId: string, classification: string): any {
    const context = this.context();
    this.validate({ ...context, action: 'inspect_customer_data', data_classification: classification }, 0);
    const raw = this.read('grant.json');
    if (sha(raw) !== this.approvedSha) return denied('APPROVAL_HASH_MISMATCH');
    const target = JSON.parse(raw.toString()).evaluation_subject;
    if (
      !target ||
      target.data_root !== resolve(dataRoot) ||
      target.batch_id !== batchId ||
      !target.project_id ||
      !target.plan_id
    )
      return denied('EVALUATION_TARGET_MISMATCH');
    return target;
  }
  workerTarget(dataRoot: string, batchId: string): any {
    const context = this.context();
    this.validate({ ...context, action: 'inspect_customer_data' }, 0);
    const raw = this.read('grant.json');
    if (sha(raw) !== this.approvedSha) return denied('APPROVAL_HASH_MISMATCH');
    const target = JSON.parse(raw.toString()).worker_subject;
    if (
      !target ||
      target.data_root !== resolve(dataRoot) ||
      target.batch_id !== batchId ||
      !target.project_id ||
      !target.plan_id ||
      !target.task_id
    )
      return denied('WORKER_TARGET_MISMATCH');
    return target;
  }
  validate(request: any, upperUsd: unknown): any {
    if (
      !['read_external', 'submit_model', 'generate_image', 'vision_review', 'inspect_customer_data'].includes(
        request.action,
      )
    )
      return denied('EXTERNAL_WRITES_FORBIDDEN');
    if (!this.enabled || !this.approvedSha) return denied('AUTH_REQUIRED');
    const raw = this.read('grant.json');
    if (sha(raw) !== this.approvedSha) return denied('APPROVAL_HASH_MISMATCH');
    const grant = JSON.parse(raw.toString()),
      isolation = JSON.parse(this.read('isolation.json').toString());
    if (grant.revoked_at_utc || existsSync(join(this.root, 'revoked'))) return denied('AUTH_REVOKED');
    const start = Date.parse(grant.approved_at_utc),
      end = Date.parse(grant.expires_at_utc);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !/[Zz]|[+-]\d\d:\d\d$/.test(grant.expires_at_utc) ||
      start > Date.now() ||
      end <= Date.now()
    )
      return denied('AUTH_EXPIRED');
    if (grant.actor_origin !== 'operator' || !grant.actor_id || !grant.human_reason)
      return denied('HUMAN_AUTH_REQUIRED');
    if (grant.environment !== 'live_sandbox' || grant.allow_external_writes !== false)
      return denied('ENVIRONMENT_DENIED');
    for (const key of ['run_id', 'system', 'tenant_id', 'environment'])
      if (request[key] !== grant[key] || request[key] !== isolation[key]) return denied('SCOPE_MISMATCH');
    if (grant.system !== 'creative_engine' || isolation.data_root !== resolve(this.root))
      return denied('ISOLATION_REQUIRED');
    for (const key of [
      'case_id',
      'dataset_id',
      'plan_hash',
      'input_hash',
      'rights_hash',
      'provider_config_hash',
    ])
      if (!request[key] || request[key] !== grant[key]) return denied('SUBJECT_MISMATCH');
    for (const key of ['plan_hash', 'input_hash', 'rights_hash', 'provider_config_hash'])
      if (!/^[0-9a-f]{64}$/.test(request[key])) return denied('INVALID_HASH');
    if (request.rights_current !== true) return denied('RIGHTS_REVOKED');
    if (!grant.data_classifications?.includes(request.data_classification))
      return denied('DATA_SCOPE_DENIED');
    if (grant.export_allowed !== true) return denied('DATA_EXPORT_DENIED');
    const cap = grant.capabilities?.[request.action];
    if (!cap) return denied('CAPABILITY_REQUIRED');
    for (const key of ['provider', 'model', 'domain'])
      if (!request[key] || request[key] !== cap[key]) return denied('CAPABILITY_CHANGED');
    for (const key of ['max_requests', 'max_images', 'max_attempts'])
      if (!Number.isSafeInteger(cap[key]) || cap[key] < 0) return denied('INVALID_LIMIT');
    if (cap.max_attempts !== 1) return denied('AUTOMATIC_RETRY_NOT_AUTHORIZED');
    if (micros(upperUsd) > micros(cap.max_usd)) return denied('BUDGET_EXCEEDED');
    if (['generate_image', 'vision_review', 'submit_model'].includes(request.action) && micros(upperUsd) <= 0)
      return denied('PRICE_CEILING_REQUIRED');
    return cap;
  }
  preflight(request: any, upperUsd: unknown, tokenPresent = false) {
    let reasons: string[] = [];
    let cap: any;
    try {
      cap = this.validate(request, upperUsd);
      const path = join(this.root, 'reservations.sqlite');
      if (existsSync(path)) {
        if (lstatSync(path).isSymbolicLink()) return denied('ISOLATION_REQUIRED');
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          if (
            db
              .prepare("SELECT 1 FROM calls WHERE grant_hash=? AND status IN ('reserved','reconciling')")
              .get(this.approvedSha)
          )
            return denied('UNRESOLVED_RECEIPT');
          const row = db
            .prepare(
              'SELECT count(*) n,coalesce(sum(max(reserved,coalesce(observed,0))),0) spent FROM calls WHERE grant_hash=? AND action=?',
            )
            .get(this.approvedSha, request.action)!;
          if (Number(row.n) >= cap.max_requests || Number(row.spent) + micros(upperUsd) > micros(cap.max_usd))
            return denied('BUDGET_EXCEEDED');
        } finally {
          db.close();
        }
      } else if (cap.max_requests === 0) return denied('BUDGET_EXCEEDED');
    } catch (e) {
      reasons = [e instanceof AppError ? e.code : 'PRIVATE_RECORD_UNAVAILABLE'];
    }
    return {
      system: 'creative_engine',
      configuration: {
        provider: ['openai', 'public_web', 'stub'].includes(request.provider) ? request.provider : 'redacted',
        model: /^(?:gpt-|o[1-9]-|chatgpt-|stub-)[a-z0-9._-]{1,80}$/.test(String(request.model))
          ? request.model
          : 'redacted_or_unselected',
        required_domain: request.provider === 'openai' ? 'api.openai.com' : 'operator_allowlist',
        capability_verified_live: false,
        environment: 'live_sandbox',
        data_classification: ['synthetic', 'public', 'redacted_business', 'sensitive_business'].includes(
          request.data_classification,
        )
          ? request.data_classification
          : 'redacted',
        action: [
          'read_external',
          'submit_model',
          'generate_image',
          'vision_review',
          'inspect_customer_data',
        ].includes(request.action)
          ? request.action
          : 'forbidden',
      },
      approved_limits: cap
        ? {
            max_requests: cap.max_requests,
            max_images: cap.max_images,
            max_attempts: cap.max_attempts,
            max_usd: micros(cap.max_usd) / 1e6,
          }
        : null,
      status: reasons.length ? 'blocked' : 'allowed',
      reasons,
      token_present: Boolean(tokenPresent),
      external_writes: false,
      live_executed: false,
    };
  }
  private db() {
    const path = join(this.root, 'reservations.sqlite');
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return denied('ISOLATION_REQUIRED');
    const db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(
      'PRAGMA busy_timeout=30000; CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, grant_hash TEXT, action TEXT, status TEXT, reserved INTEGER, observed INTEGER, images INTEGER, basis TEXT)',
    );
    return db;
  }
  reserve(id: string, request: any, upperUsd: unknown, images = 0) {
    this.validate(request, upperUsd);
    if (!id || id.length > 200 || !Number.isSafeInteger(images) || images < 0)
      return denied('INVALID_REQUEST');
    const db = this.db();
    try {
      db.exec('BEGIN IMMEDIATE');
      const cap = this.validate(request, upperUsd);
      if (db.prepare('SELECT 1 FROM calls WHERE id=?').get(id)) return denied('ALREADY_RESERVED_RECONCILE');
      if (
        db
          .prepare("SELECT 1 FROM calls WHERE grant_hash=? AND status IN ('reserved','reconciling')")
          .get(this.approvedSha)
      )
        return denied('UNRESOLVED_RECEIPT');
      const totals = db
        .prepare(
          'SELECT count(*) n,coalesce(sum(max(reserved,coalesce(observed,0))),0) spent,coalesce(sum(images),0) images FROM calls WHERE grant_hash=? AND action=?',
        )
        .get(this.approvedSha, request.action)!;
      if (
        Number(totals.n) + 1 > cap.max_requests ||
        Number(totals.spent) + micros(upperUsd) > micros(cap.max_usd) ||
        Number(totals.images) + images > cap.max_images
      )
        return denied('BUDGET_EXCEEDED');
      db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)').run(
        id,
        this.approvedSha,
        request.action,
        'reserved',
        micros(upperUsd),
        null,
        images,
        'unknown',
      );
      db.exec('COMMIT');
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
    }
  }
  settle(id: string, cost: number | null, basis: 'actual' | 'estimated' | 'unknown') {
    if ((basis === 'unknown') !== (cost === null)) return denied('UNKNOWN_COST_IS_NOT_ZERO');
    const db = this.db();
    try {
      const result = db
        .prepare(
          "UPDATE calls SET status=?,observed=?,basis=? WHERE id=? AND grant_hash=? AND status='reserved'",
        )
        .run(
          basis === 'unknown' ? 'reconciling' : 'completed',
          cost === null ? null : micros(cost),
          basis,
          id,
          this.approvedSha,
        );
      if (result.changes !== 1) return denied('RECEIPT_NOT_SETTLEABLE');
    } finally {
      db.close();
    }
  }
}

/** Check at the last external-call boundary, even when a caller bypasses Core. */
export function livePermission(
  action: string,
  provider: string,
  model: string,
  inputHash: string,
  configHash: string,
  ceiling: number,
  requestId: string,
  images = 0,
) {
  const policy = new ValidationRunPolicy();
  if (!policy.enabled || !policy.approvedSha) return denied('AUTH_REQUIRED');
  const context = policy.context();
  const request = {
    ...context,
    action,
    provider,
    model,
    domain: provider === 'openai' ? 'api.openai.com' : 'chatgpt.com',
    input_hash: inputHash,
    provider_config_hash: configHash,
  };
  policy.reserve(requestId, request, ceiling, images);
  return {
    assertCurrent: () => policy.validate(request, ceiling),
    complete: (cost: number, basis: 'actual' | 'estimated' = 'estimated') =>
      policy.settle(requestId, cost, basis),
    unknown: () => policy.settle(requestId, null, 'unknown'),
  };
}
