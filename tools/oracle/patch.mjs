import { ownedImageSnapshot } from './image-dom.mjs';

/** Latches the first stable post-submit URL; a later mismatch cannot be cleared. */
export function createConversationIdentity() {
  let fixed;
  let invalid = false;
  function fail(code) { const error = new Error(code); error.code = code; throw error; }
  function parse(value) {
    try {
      const url = new URL(value);
      if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(url.origin)) return undefined;
      return /^\/c\/([a-zA-Z0-9-]+)\/?$/.exec(url.pathname)?.[1];
    } catch { return undefined; }
  }
  return {
    observe(value) {
      if (invalid) fail('CE_ORACLE_CONVERSATION_CHANGED');
      const id = parse(value);
      if (!id) { if (fixed) { invalid = true; fail('CE_ORACLE_CONVERSATION_CHANGED'); } return; }
      if (fixed && id !== fixed) { invalid = true; fail('CE_ORACLE_CONVERSATION_CHANGED'); }
      fixed ??= id;
      return fixed;
    },
    current(value) {
      if (invalid) fail('CE_ORACLE_CONVERSATION_CHANGED');
      if (!fixed) fail('CE_ORACLE_CONVERSATION_UNCONFIRMED');
      if (parse(value) !== fixed) { invalid = true; fail('CE_ORACLE_CONVERSATION_CHANGED'); }
      return fixed;
    },
  };
}

function replaceOnce(source, before, after, count = 1) {
  if (source.split(before).length - 1 !== count) throw new Error('ORACLE_PATCH_CONTEXT_MISMATCH');
  return source.split(before).join(after);
}
function replaceFunction(source, start, end, replacement) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + start.length) >= 0) throw new Error('ORACLE_PATCH_FUNCTION_MISMATCH');
  return source.slice(0, a) + replacement + '\n' + source.slice(b);
}

export function patchSource(relativePath, source) {
  if (relativePath === 'dist/src/browser/index.js') {
    source = 'const ceCreateConversationIdentity = ' + createConversationIdentity.toString() + ';\n' + source;
    source = replaceOnce(source, '    let submittedPromptHash = null;', '    let submittedPromptHash = null;\n    const ceConversation = ceCreateConversationIdentity();', 2);
    source = replaceOnce(source, 'persistUrl: async (url) => {\n                lastUrl = url;', 'persistUrl: async (url) => {\n                if (promptSubmitted) ceConversation.observe(url);\n                lastUrl = url;', 2);
    source = replaceOnce(source, 'const expectedConversationId = () => lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;', 'const expectedConversationId = () => ceConversation.current(lastUrl);', 2);
    source = replaceOnce(source, 'readAssistantGeneratedImages(Runtime, minTurnIndex, expectedConversationId).catch(() => [])', 'readAssistantGeneratedImages(Runtime, minTurnIndex, expectedConversationId).catch(error => { if (error?.code?.startsWith("CE_ORACLE_")) throw error; return []; })');
    const matches = [...source.matchAll(/const imageArtifacts = await collectGeneratedImageArtifacts\(\{[\s\S]*?minTurnIndex: imageArtifactMinTurnIndex,/g)];
    if (matches.length !== 2) throw new Error('ORACLE_PATCH_IMAGE_CALL_MISMATCH');
    for (const match of matches) source = replaceOnce(source, match[0], match[0] + '\n            expectedConversationId: expectedConversationId(),');
    return source;
  }
  if (relativePath !== 'dist/src/browser/chatgptImages.js') return source;
  source = replaceFunction(source, 'function buildAssistantImageExpression(', 'export async function readAssistantGeneratedImages(',
    `function buildAssistantImageExpression(minTurnIndex, expectedConversationId) { return ${JSON.stringify('(' + ownedImageSnapshot.toString() + ')(')} + JSON.stringify(expectedConversationId ?? null) + ', ' + JSON.stringify(minTurnIndex ?? null) + ')'; }\nconst ceImageStability = new WeakMap();`);
  source = replaceOnce(source, '    const raw = Array.isArray(result?.value) ? result.value : [];', `    if (['CE_ORACLE_IMAGE_GENERATION_FAILED', 'CE_ORACLE_RESPONSE_UNAVAILABLE'].includes(result?.value?.ceTerminalError)) {
      const error = new Error(result.value.ceTerminalError); error.code = result.value.ceTerminalError; throw error;
    }
    const raw = Array.isArray(result?.value) ? result.value : [];`);
  source = replaceOnce(source, '    return dedupeImages(normalized);', `    const unique = dedupeImages(normalized);
    const fingerprint = JSON.stringify([expectedConversationId, minTurnIndex, unique]);
    const previous = ceImageStability.get(Runtime);
    const now = Date.now();
    if (!unique.length || !previous || previous.fingerprint !== fingerprint) {
        ceImageStability.set(Runtime, { fingerprint, since: now });
        return [];
    }
    return now - previous.since >= 500 ? unique : [];`);
  source = replaceFunction(source, 'async function readAssistantGeneratedImagesWithFallback(', 'function resolveGeneratedImageWaitTimeoutMs(',
    `async function readAssistantGeneratedImagesWithFallback(Runtime, minTurnIndex, expectedConversationId) {
      if (!expectedConversationId || !Number.isInteger(minTurnIndex) || minTurnIndex < 0) throw new Error('ORACLE_IMAGE_OWNERSHIP_REQUIRED');
      return readAssistantGeneratedImages(Runtime, minTurnIndex, expectedConversationId);
    }`);
  source = replaceOnce(source,
    'readAssistantGeneratedImagesWithFallback(params.Runtime, params.minTurnIndex ?? undefined)',
    'readAssistantGeneratedImagesWithFallback(params.Runtime, params.minTurnIndex ?? undefined, params.expectedConversationId)', 2);
  source = replaceFunction(source, 'async function saveGeneratedImageButtonArtifacts(', 'function formatButtonImageArtifacts(',
    `async function saveGeneratedImageButtonArtifacts() { return []; }`);
  // Browser credentials stay in the browser; no Node cookie-header copy or redirect leakage.
  source = replaceOnce(source, "fetch(url, { credentials: 'include', redirect: 'follow' })", "fetch(url, { credentials: 'include', redirect: 'error' })");
  const before = '    const needsCookies = images.some((image) => normalizeGeneratedImageUrl(image.url)?.startsWith("https:"));';
  const start = source.indexOf(before), end = source.indexOf('    const savedImages = [];', start);
  if (start < 0 || end < 0) throw new Error('ORACLE_PATCH_DOWNLOAD_MISMATCH');
  source = source.slice(0,start) + '    if (!Runtime) throw new Error("ORACLE_BROWSER_RUNTIME_REQUIRED");\n' + source.slice(end);
  const a = source.indexOf('            let contentType = null;'), z = source.indexOf('            const extension = contentTypeToExtension(contentType);', a);
  if (a < 0 || z < 0) throw new Error('ORACLE_PATCH_DOWNLOAD_MISMATCH');
  source = source.slice(0,a) + `            const observed = await readAssistantGeneratedImagesWithFallback(Runtime, params.minTurnIndex, params.expectedConversationId);
            if (!observed.some(candidate => candidate.url === imageUrl)) throw new Error('ORACLE_IMAGE_OWNERSHIP_CHANGED');
            const downloaded = await fetchGeneratedImageInBrowserContext(Runtime, imageUrl);
            const buffer = downloaded.buffer;
            const detected = detectImageFile(buffer);
            if (!detected || detected.extension === 'svg' || buffer.length > 32 * 1024 * 1024) throw new Error('ORACLE_IMAGE_INVALID_BYTES');
            const after = await readAssistantGeneratedImagesWithFallback(Runtime, params.minTurnIndex, params.expectedConversationId);
            if (!after.some(candidate => candidate.url === imageUrl)) throw new Error('ORACLE_IMAGE_OWNERSHIP_CHANGED');
            const contentType = detected.mimeType;
            const finalUrl = downloaded.finalUrl;
` + source.slice(z);
  source = replaceOnce(source, 'await fs.writeFile(targetPath, buffer);', `const temporaryPath = targetPath + '.' + randomUUID() + '.partial';
            try {
                const handle = await fs.open(temporaryPath, 'wx', 0o600);
                try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
                await fs.link(temporaryPath, targetPath); // Atomic publication; never overwrites an existing result.
            } finally { await fs.unlink(temporaryPath).catch(() => undefined); }`);
  source = replaceOnce(source, '        images: generatedImages,\n        outputPath: targetPath,', '        images: generatedImages,\n        minTurnIndex: params.minTurnIndex,\n        expectedConversationId: params.expectedConversationId,\n        outputPath: targetPath,');
  source = source.replaceAll('No images generated. Response text:', 'ORACLE_IMAGE_RESULT_UNKNOWN. Response text:');
  return source;
}
