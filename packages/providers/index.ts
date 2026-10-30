export * from './types.js';
export { MockProvider } from './mock/index.js';
export { OpenAIImageProvider, classifyOpenAIError, usageCost } from './openai-image/index.js';
export { OracleProvider } from './oracle/index.js';
import path from 'node:path';
import { MockProvider } from './mock/index.js';
import { OpenAIImageProvider } from './openai-image/index.js';
import { OracleProvider } from './oracle/index.js';
import type { ImageProvider } from './types.js';
export function createProviders(dataDir?: string): Map<string, ImageProvider> {
  const root = path.resolve(
    dataDir ?? process.env.CREATIVE_DATA_DIR ?? '.creative-engine',
    'provider-receipts',
  );
  const providers: ImageProvider[] = [
    new MockProvider(path.join(root, 'mock')),
    new OpenAIImageProvider({ stateDir: path.join(root, 'openai') }),
    new OracleProvider({ stateDir: path.join(root, 'oracle') }),
  ];
  return new Map(providers.map((provider) => [provider.id, provider]));
}
