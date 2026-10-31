/** Serialized into Oracle's existing Runtime. Pure DOM read; never submits or navigates. */
export function ownedImageSnapshot(expectedConversationId, minTurnIndex) {
  if (!expectedConversationId || !/^[a-zA-Z0-9-]+$/.test(expectedConversationId)) return [];
  if (!Number.isInteger(minTurnIndex) || minTurnIndex < 0) return [];
  if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(location.origin)) return [];
  if (location.pathname !== '/c/' + expectedConversationId) return [];
  const visible = (node) => !!node && !!node.getClientRects().length;
  const main = Array.from(document.querySelectorAll('main')).find(visible);
  if (!main) return [];
  const stopSelector = '[data-testid="stop-button"], [data-testid="composer-stop-button"], form button[aria-label*="stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])';
  if (Array.from(main.querySelectorAll(stopSelector)).some(visible)) return [];
  const turnSelector = '[data-turn-key], [data-testid^="conversation-turn"], [data-content-search-unit-key], [data-chatgpt-search-unit-key]';
  const turns = Array.from(main.querySelectorAll(turnSelector)).filter(n => !n.parentElement?.closest(turnSelector));
  if (turns.length <= minTurnIndex) return [];
  const userSelector = '[data-message-author-role="user"], [data-turn="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]';
  const ownedUsers = new Set();
  for (const turn of turns.slice(minTurnIndex)) {
    const users = [...(turn.matches(userSelector) ? [turn] : []), ...turn.querySelectorAll(userSelector)];
    for (const user of users) if (!user.parentElement?.closest(userSelector)) ownedUsers.add(user);
  }
  // Modern DOM nests duplicate user aliases. Deduplicate those, but never adopt
  // a later request in this conversation as the result of the current attempt.
  if (ownedUsers.size !== 1) return [];
  const latestUser = [...ownedUsers][0];
  if (!visible(latestUser)) return [];
  const images = [];
  for (const img of main.querySelectorAll('img')) {
    if (!visible(img) || !img.complete || img.naturalWidth < 1 || img.naturalHeight < 1) continue;
    if (img.closest(userSelector) || latestUser.contains(img)) continue;
    if (!(latestUser.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const generation = img.closest('[data-testid="generated-image-preview"], [data-testid="generated-image-gallery"]');
    if (!generation) continue;
    const state = img.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state');
    if (state && state !== 'complete') continue;
    let url;
    try { url = new URL(img.src, location.origin); } catch { continue; }
    if (url.protocol === 'blob:') {
      let origin;
      try { origin = new URL(url.pathname); } catch { continue; }
      if (origin.origin !== location.origin) continue;
    } else if (url.origin !== location.origin || url.pathname !== '/backend-api/estuary/content' || !(url.searchParams.get('id') ?? '').startsWith('file_')) continue;
    images.push({ url: url.href, alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight });
  }
  return images;
}

export function imageExpression(minTurnIndex, expectedConversationId) {
  return `(${ownedImageSnapshot.toString()})(${JSON.stringify(expectedConversationId ?? null)}, ${JSON.stringify(minTurnIndex ?? null)})`;
}
