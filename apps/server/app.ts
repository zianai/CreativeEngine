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
export { openapi } from './openapi.js';
export async function buildApp(core = new Core(), workerEnabled = true) {
  const app = Fastify({ logger: false, bodyLimit: 29 * 1024 * 1024 });
  const worker = new Worker(core);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const hostname = (req.headers.host ?? '').split(':')[0];
    if (hostname && !['localhost', '127.0.0.1', '[', '::1'].includes(hostname)) {
      reply.code(403);
      throw new AppError('HOST_REJECTED', 'Local host required', 403);
    }
    if (origin) {
      let host;
      try {
        host = new URL(origin).hostname;
      } catch {}
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host ?? '')) {
        reply.code(403);
        throw new AppError('ORIGIN_REJECTED', 'Untrusted origin', 403);
      }
    }
    const token = process.env.CREATIVE_API_TOKEN;
    if (token && req.url.startsWith('/v1') && req.headers.authorization !== `Bearer ${token}`)
      throw new AppError('UNAUTHORIZED', 'Local API token required', 401);
    if (req.url.startsWith('/v1')) requireProtocol(req.headers['x-api-version']);
  });
  app.setErrorHandler((err: any, _req, reply) => {
    const validation = err instanceof ZodError;
    reply
      .code(validation ? 400 : (err.status ?? err.statusCode ?? 500))
      .send({
        error: {
          code: validation ? 'VALIDATION_ERROR' : (err.code ?? 'INTERNAL_ERROR'),
          message: validation
            ? 'Invalid request'
            : err.status || err.statusCode
              ? err.message
              : 'Internal operation failed',
          details: validation ? err.issues : err.details,
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
