import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../packages/core/service.js';
import { Worker } from '../packages/core/worker.js';
import { MockProvider } from '../packages/providers/mock/index.js';
import { evaluationSnapshot } from '../packages/core/evaluation.js';
import { authorizedEvaluation } from '../packages/core/evaluation-export.js';
import { ValidationRunPolicy } from '../packages/core/validation.js';
const args = process.argv.slice(2);
let payload: unknown, output: string;
if (args[0] === '--synthetic-fixture' && args.length === 2) {
  output = args[1];
  const root = mkdtempSync(join(tmpdir(), 'ce-evaluation-fixture-'));
  const core = new Core(root, new Map([['mock', new MockProvider(join(root, 'provider-receipts/mock'))]]));
  try {
    const project = core.project({ name: 'SYNTHETIC E1 EVALUATION — NOT BUSINESS' });
    const brief = core.brief({
      project_id: project.id,
      workflow: 'product-concept',
      product: { product_id: 'SYNTHETIC', stage: 'concept' },
      requirements: 'Generated local fixture only',
      variants: 1,
    });
    const batch = core.createBatch({ plan_id: core.plan(brief.id).id, budget_usd: 0 });
    await new Worker(core).drain();
    payload = {
      ...evaluationSnapshot(core, batch.id),
      classification: 'synthetic',
      synthetic: true,
      fixture_origin: 'new_tool_owned_temporary_workspace',
    };
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
} else {
  const [root, batchId, newOutput, classification] = args;
  if (args.length !== 4)
    throw new Error(
      'Usage: --synthetic-fixture NEW_OUTPUT | DATA_ROOT BATCH_ID NEW_OUTPUT public|redacted_business|sensitive_business',
    );
  output = newOutput;
  const policy = new ValidationRunPolicy();
  if (!policy.root || resolve(dirname(output)) !== resolve(policy.root))
    throw new Error('PRIVATE_OPERATOR_OUTPUT_REQUIRED');
  payload = authorizedEvaluation(policy, root, batchId, classification);
}
writeFileSync(output, JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
console.log('Metadata exported; no review, external-use permission, or business acceptance created.');
