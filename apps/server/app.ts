import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
import { inside } from '../../packages/core/files.js';
import { AppError } from '../../packages/contracts/index.js';
import { openapi } from './openapi.js';
import { planTradeCase, tradeCaseResult } from '../../packages/integrations/tradecase/index.js';
import { requireProtocol } from './protocol.js';
import { randomBytes, createHash } from 'node:crypto';
export { openapi } from './openapi.js';
export async function buildApp(core = new Core(), workerEnabled = true) {
  const app = Fastify({ logger: false, bodyLimit: 29 * 1024 * 1024 });
  const worker = new Worker(core);
  const sessions = new Map<string, { tokenHash: string; expires: number }>();
  const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
  let writeWindow = Date.now(),
    writes = 0;
  const maxWrites = Number(process.env.CREATIVE_WRITE_RATE_LIMIT ?? 120);
  if (!Number.isSafeInteger(maxWrites) || maxWrites < 1 || maxWrites > 10000)
    throw new Error('Invalid local write rate limit');
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    let hostname = '';
    try {
      hostname = new URL(`http://${req.headers.host ?? ''}`).hostname;
    } catch {}
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      reply.code(403);
      throw new AppError('HOST_REJECTED', 'Local host required', 403);
    }
    if (origin) {
      let host;
      try {
        host = new URL(origin).hostname;
      } catch {}
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(host ?? '') ||
        !['http:', 'https:'].includes(new URL(origin).protocol) ||
        new URL(origin).host !== req.headers.host
      ) {
        reply.code(403);
        throw new AppError('ORIGIN_REJECTED', 'Untrusted origin', 403);
      }
    }
    const token = process.env.CREATIVE_API_TOKEN;
    if (!token && req.url.startsWith('/v1') && req.url.split('?')[0] !== '/v1/health')
      throw new AppError('AUTH_NOT_CONFIGURED', 'A dedicated local API token must be configured', 503);
    const sessionId = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ce_session='))
      ?.slice('ce_session='.length);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const sessionValid = Boolean(
      token && session && session.expires > Date.now() && session.tokenHash === tokenHash(token),
    );
    if (
      token &&
      req.url.startsWith('/v1') &&
      req.headers.authorization !== `Bearer ${token}` &&
      !sessionValid
    )
      throw new AppError('UNAUTHORIZED', 'Local API token required', 401);
    if (req.url.startsWith('/v1')) requireProtocol(req.headers['x-api-version']);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (Date.now() - writeWindow >= 60000) {
        writeWindow = Date.now();
        writes = 0;
      }
      if (++writes > maxWrites) {
        reply.header('Retry-After', '60');
        throw new AppError('RATE_LIMITED', 'Local write quota exceeded', 429);
      }
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((err: any, _req, reply) => {
    const validation = err instanceof ZodError;
    reply.code(validation ? 400 : (err.status ?? err.statusCode ?? 500)).send({
      error: {
        code: validation ? 'VALIDATION_ERROR' : (err.code ?? 'INTERNAL_ERROR'),
        message: validation ? 'Invalid request' : 'Request could not be completed; see error code',
        details: validation ? err.issues.map((issue: any) => ({ code: issue.code })) : undefined,
      },
    });
  });
  const params = (req: any) => req.params as any;
  const list = (req: any, items: any[]) => {
    const q = req.query as any;
    const offset = Math.max(0, Number(q.offset) || 0),
      limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
  };
  const projectId = (req: any) => (req.query as any).project_id;
  app.get('/v1/health', async () => ({
    status: 'ok',
    schema_version: '1.0.0',
    storage: 'sqlite-wal',
    worker: workerEnabled,
    real_provider_status: 'See /v1/providers; mock is not live generation verification',
  }));
  app.get('/v1/dashboard', async () => core.dashboard());
  app.post('/v1/session', async (req, reply) => {
    const token = process.env.CREATIVE_API_TOKEN!;
    if (req.headers.authorization !== `Bearer ${token}`)
      throw new AppError('UNAUTHORIZED', 'Enter the local API token', 401);
    for (const [id, s] of sessions) if (s.expires <= Date.now()) sessions.delete(id);
    if (sessions.size >= 64) throw new AppError('SESSION_LIMIT', 'Too many active local sessions', 429);
    const id = randomBytes(32).toString('hex');
    sessions.set(id, { tokenHash: tokenHash(token), expires: Date.now() + 3600000 });
    reply.header('Set-Cookie', `ce_session=${id}; HttpOnly; SameSite=Strict; Path=/v1; Max-Age=3600`);
    return { connected: true, expires_in_seconds: 3600, scope: 'trusted_local_operator' };
  });
  app.post('/v1/session/end', async (req, reply) => {
    const id = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ce_session='))
      ?.slice('ce_session='.length);
    if (id) sessions.delete(id);
    reply.header('Set-Cookie', 'ce_session=; HttpOnly; SameSite=Strict; Path=/v1; Max-Age=0');
    return { connected: false };
  });
  app.get('/v1/operations/status', async () => core.operationsStatus());
  app.get('/v1/providers', async (req) => list(req, await core.providerList()));
  app.get('/v1/skills', async (req) => list(req, core.skills()));
  app.get('/v1/delivery-rules', async (req) => list(req, core.deliveryRules()));
  app.get('/v1/projects', async (req) => list(req, core.store.list('project')));
  app.post('/v1/projects', async (req, reply) => reply.code(201).send(core.project(req.body)));
  app.get('/v1/projects/:id', async (req) => core.require('project', params(req).id));
  app.post('/v1/truth-snapshots', async (req, reply) => reply.code(201).send(core.truth(req.body)));
  app.get('/v1/truth-snapshots', async (req) => list(req, core.store.list('truth', projectId(req))));
  app.get('/v1/truth-snapshots/:id', async (req) => core.require('truth', params(req).id));
  app.post('/v1/assets/import', async (req, reply) => reply.code(201).send(await core.importAsset(req.body)));
  app.get('/v1/assets', async (req) =>
    list(
      req,
      core.store.list('asset', projectId(req)).map((a) => core.asset(a.id)),
    ),
  );
  app.get('/v1/assets/:id', async (req) => core.asset(params(req).id));
  app.get('/v1/assets/:id/file', async (req, reply) => {
    const a = core.require('asset', params(req).id);
    reply.header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'");
    reply.type(a.format ? `image/${a.format}` : 'application/octet-stream');
    if (a.kind === 'document') reply.header('Content-Disposition', 'attachment');
    return reply.send(createReadStream(await core.file(a.id)));
  });
  app.post('/v1/assets/:id/review', async (req) => core.review(params(req).id, req.body));
  app.post('/v1/briefs', async (req, reply) => reply.code(201).send(core.brief(req.body)));
  app.get('/v1/briefs/:id', async (req) => core.require('brief', params(req).id));
  app.post('/v1/briefs/:id/plan', async (req) => core.plan(params(req).id));
  app.get('/v1/plans/:id', async (req) => core.require('plan', params(req).id));
  app.post('/v1/batches', async (req, reply) => {
    const input = {
      ...(req.body as object),
      ...(req.headers['idempotency-key'] ? { idempotency_key: req.headers['idempotency-key'] } : {}),
    };
    return reply.code(202).send(core.createBatch(input));
  });
  app.get('/v1/batches', async (req) =>
    list(
      req,
      core.store.list('batch', projectId(req)).map((b) => core.batch(b.id)),
    ),
  );
  app.get('/v1/batches/:id', async (req) => core.batch(params(req).id));
  for (const action of ['cancel', 'pause', 'resume'])
    app.post(`/v1/batches/:id/${action}`, async (req) => core.controlBatch(params(req).id, action));
  app.get('/v1/tasks/:id', async (req) => {
    const t = core.require('task', params(req).id);
    return { ...core.publicTask(t), attempts: core.store.list('attempt').filter((a) => a.task_id === t.id) };
  });
  app.post('/v1/tasks/:id/revise', async (req, reply) =>
    reply.code(202).send(core.revise(params(req).id, req.body)),
  );
  app.get('/v1/exports', async (req) =>
    list(
      req,
      core.store.list('export', projectId(req)).map(({ path, ...result }) => result),
    ),
  );
  app.post('/v1/tasks/:id/reconcile', async (req) => core.reconcile(params(req).id, req.body));
  app.post('/v1/exports', async (req, reply) => reply.code(201).send(await core.export(req.body)));
  app.get('/v1/exports/:id', async (req) => {
    const { path, ...result } = core.require('export', params(req).id);
    return result;
  });
  app.get('/v1/exports/:id/file', async (req, reply) => {
    const pkg = core.require('export', params(req).id);
    core.exportReady(pkg.id);
    return reply
      .header('Content-Disposition', `attachment; filename="${pkg.id}.zip"`)
      .type('application/zip')
      .send(createReadStream(await inside(core.root, pkg.path)));
  });
  app.get('/v1/events', async (req, reply) => {
    const origin = req.headers.origin;
    let after = Number(req.headers['last-event-id'] ?? (req.query as any).after ?? 0) || 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const pump = () => {
      for (const event of core.store.events(after)) {
        reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        after = event.seq;
      }
    };
    pump();
    const timer = setInterval(pump, 500),
      keep = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
    req.raw.on('close', () => {
      clearInterval(timer);
      clearInterval(keep);
    });
  });
  app.post('/v1/integrations/tradecase/plan', async (req, reply) =>
    reply.code(201).send(await planTradeCase(core, req.body)),
  );
  app.get('/v1/integrations/tradecase/batches/:id', async (req) => tradeCaseResult(core, params(req).id));
  app.get('/v1/openapi.json', async () => openapi());
  const studio = resolve(fileURLToPath(new URL('../studio/dist', import.meta.url)));
  if (existsSync(join(studio, 'index.html'))) {
    await app.register(staticPlugin, { root: studio, prefix: '/' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/v1')
        ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
        : reply.sendFile('index.html'),
    );
  } else
    app.get('/', async () => ({ message: 'Run pnpm build to serve Creative Studio', api: '/v1/health' }));
  app.addHook('onClose', async () => {
    await worker.stop();
    core.close();
  });
  if (workerEnabled) worker.start();
  return { app, core, worker };
}
