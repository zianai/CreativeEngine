import { buildApp } from './app.js';
const { app, core } = await buildApp(undefined, process.env.CREATIVE_WORKER !== '0');
await core.providerList(); // Read-only capability probes; no image requests.
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4310) });
console.log(`Creative Engine ready: http://127.0.0.1:${process.env.PORT ?? 4310}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
