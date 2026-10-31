import test from 'node:test';
import assert from 'node:assert/strict';
import { visionUsageCost } from '../../packages/quality/index.js';
test('Vision cache-write usage cannot silently use ordinary input tariff', () => {
  assert.equal(
    visionUsageCost(
      { input_tokens: 1463, output_tokens: 446, input_tokens_details: { cache_write_tokens: 1460 } },
      1,
      5,
    ),
    null,
  );
  assert.equal(
    visionUsageCost(
      { input_tokens: 1463, output_tokens: 446, input_tokens_details: { cache_write_tokens: 0 } },
      1,
      5,
    ),
    0.003693,
  );
  for (const bad of [
    { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 1, output_tokens: NaN },
    { output_tokens: 3 },
  ])
    assert.equal(visionUsageCost(bad, 1, 5), null);
});
