import { Core } from '../../packages/core/service.js';
import { Worker } from '../../packages/core/worker.js';
const core = new Core(),
  worker = new Worker(core, Number(process.env.CREATIVE_CONCURRENCY ?? 2));
worker.start();
console.log('Creative Engine worker running');
const keepAlive = setInterval(() => {}, 60000);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(keepAlive);
    void worker.stop().then(() => {
      core.close();
      process.exit(0);
    });
  });
