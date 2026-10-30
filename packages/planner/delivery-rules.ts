import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  AppError,
  DeliveryRuleDefinitionSchema,
  DeliveryRuleSnapshotSchema,
  sha256,
  type DeliveryRuleSnapshot,
} from '../contracts/index.js';
const defaultRulesRoot = fileURLToPath(new URL('../../rules/', import.meta.url));
/** Configuration is data only: no rule module execution and no policy inference by a model. */
export function loadDeliveryRules(root = defaultRulesRoot): DeliveryRuleSnapshot[] {
  const ids = new Set<string>();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const rule = DeliveryRuleDefinitionSchema.parse(parse(readFileSync(join(root, entry.name), 'utf8')));
      if (ids.has(rule.id))
        throw new AppError('DELIVERY_RULE_DUPLICATE', `Delivery rule ID is not unique: ${rule.id}`);
      ids.add(rule.id);
      if (rule.scope === 'official' && !/^https:\/\//.test(rule.source))
        throw new AppError(
          'DELIVERY_RULE_SOURCE',
          'An official delivery rule requires its authoritative HTTPS source URL.',
        );
      if (rule.source_date > new Date().toISOString().slice(0, 10))
        throw new AppError('DELIVERY_RULE_DATE', 'Delivery rule source date cannot be in the future.');
      return { ...rule, digest: sha256(JSON.stringify(rule)) };
    });
}
export function deliveryRule(id: string, root?: string): DeliveryRuleSnapshot {
  const rule = loadDeliveryRules(root).find((candidate) => candidate.id === id);
  if (!rule) throw new AppError('DELIVERY_RULE_NOT_FOUND', `Delivery rule is unavailable: ${id}`, 404);
  return rule;
}
export function validateDeliveryRuleSnapshot(value: unknown, expectedId?: string): DeliveryRuleSnapshot {
  const rule = DeliveryRuleSnapshotSchema.parse(value),
    { digest, ...definition } = rule;
  if ((expectedId && rule.id !== expectedId) || sha256(JSON.stringify(definition)) !== digest)
    throw new AppError(
      'DELIVERY_RULE_SNAPSHOT_INVALID',
      'Saved delivery rule does not match its ID or content digest.',
      409,
    );
  return rule;
}
