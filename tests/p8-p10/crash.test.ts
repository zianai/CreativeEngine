import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../../packages/core/service.js';
for (const mode of ['claimed', 'submitted', 'saved', 'vision_started'])
  test(`P9-T015..018 real process death ${mode} and restart`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ce-crash-process-'));
    const run = (state: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'tests/p8-p10/crash-child.ts', root, state], {
        cwd: resolve('.'),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          ALLOW_TEST_LIVE: 'off',
        },
        encoding: 'utf8',
        timeout: 20000,
      });
    try {
      const failed = run(mode);
      assert.equal(failed.status, 86, failed.stderr);
      const resumed = run('recover');
      assert.equal(resumed.status, 0, resumed.stderr);
      const second = run('recover');
      assert.equal(second.status, 0, second.stderr);
      const calls = existsSync(join(root, 'calls.txt'))
        ? readFileSync(join(root, 'calls.txt'), 'utf8').trim().split('\n')
        : [];
      assert.equal(calls.filter((c) => c === 'image').length, 1);
      assert.equal(calls.filter((c) => c === 'vision').length, mode === 'vision_started' ? 1 : 0);
      const core = new Core(root, new Map());
      try {
        const t = core.store.tasks()[0];
        assert.equal(
          t.status,
          mode === 'submitted' ? 'reconciling' : mode === 'vision_started' ? 'blocked' : 'review_pending',
        );
        if (mode === 'submitted' || mode === 'vision_started') {
          assert.equal(core.batch(t.batch_id).cost_summary.charge_status, 'unknown');
          assert.equal(core.batch(t.batch_id).cost_summary.actual_cost_usd, null);
        } else {
          assert.equal(core.store.list('asset').length, 1);
          assert.equal(core.store.list('asset')[0].review_status, 'pending');
        }
      } finally {
        core.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const field of ['artifact_sha256', 'attempt_id'])
  test(`P9-T017 protocol 2 receipt missing ${field} never recovers as approved or regenerates`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ce-receipt-missing-'));
    const run = (mode: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'tests/p8-p10/crash-child.ts', root, mode], {
        cwd: resolve('.'),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          ALLOW_TEST_LIVE: 'off',
        },
        encoding: 'utf8',
        timeout: 20000,
      });
    try {
      assert.equal(run('saved').status, 86);
      let core = new Core(root, new Map());
      const task = core.store.tasks()[0];
      core.close();
      const path = join(root, 'attempts', task.attempt_id, 'receipt.json'),
        receipt = JSON.parse(readFileSync(path, 'utf8'));
      delete receipt.metadata[field];
      writeFileSync(path, JSON.stringify(receipt));
      assert.equal(run('recover').status, 0);
      assert.equal(run('recover').status, 0);
      core = new Core(root, new Map());
      try {
        assert.equal(core.store.tasks()[0].status, 'reconciling');
        assert.equal(core.store.list('asset').length, 0);
        assert.equal(core.batch(task.batch_id).cost_summary.actual_cost_usd, null);
      } finally {
        core.close();
      }
      assert.equal(readFileSync(join(root, 'calls.txt'), 'utf8').trim(), 'image');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
