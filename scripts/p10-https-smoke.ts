/** Ephemeral loopback HTTPS drill; certificate is trusted only by this one test request. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as tlsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { Core } from '../packages/core/service.js';
import { MockProvider } from '../packages/providers/mock/index.js';
import { buildApp } from '../apps/server/app.js';
import { hash } from '../packages/core/files.js';
const root = mkdtempSync(join(tmpdir(), 'ce-tls-'));
const key = join(root, 'key.pem'),
  cert = join(root, 'cert.pem');
const result = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout',
    key,
    '-out',
    cert,
  ],
  { stdio: 'ignore' },
);
assert.equal(result.status, 0);
process.env.CREATIVE_API_TOKEN = 'SYNTHETIC-TLS-ONLY';
const core = new Core(
  join(root, 'data'),
  new Map([['mock', new MockProvider(join(root, 'data/provider-receipts/mock'))]]),
);
const { app } = await buildApp(core, false);
let proxy: ReturnType<typeof createServer> | undefined;
try {
  const base = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  proxy = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const upstream = httpRequest(
      { hostname: '127.0.0.1', port: base.port, path: req.url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 500, r.headers);
        r.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as any).port;
  const status = await new Promise<number>((resolve, reject) => {
    const req = tlsRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/health',
        ca: readFileSync(cert),
        headers: { authorization: 'Bearer SYNTHETIC-TLS-ONLY' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 200);
  console.log(
    JSON.stringify({
      scope: 'ephemeral_loopback_https_only',
      status,
      certificate_sha256: hash(readFileSync(cert)),
      public_exposure: false,
      production_trust: 'not_validated',
    }),
  );
} finally {
  await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
