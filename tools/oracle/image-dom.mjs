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
  let hasOwnedImageElement = false;
  for (const img of main.querySelectorAll('img')) {
    if (img.closest(userSelector) || latestUser.contains(img)) continue;
    if (!(latestUser.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const generation = img.closest('[data-testid="generated-image-preview"], [data-testid="generated-image-gallery"]');
    if (!generation) continue;
    hasOwnedImageElement = true;
    if (!visible(img) || !img.complete || img.naturalWidth < 1 || img.naturalHeight < 1) continue;
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
  if (!hasOwnedImageElement) {
    for (const button of main.querySelectorAll('button')) {
      if (!visible(button) || !['重试', 'Retry', 'Try again'].includes(button.textContent?.trim())) continue;
      if (button.closest(userSelector) || !(latestUser.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const card = button.parentElement;
      const state = card?.parentElement;
      // Observed provider error card is a direct child of the completed exchange,
      // outside markdown/user content. Do not classify quoted error prose.
      if (state?.getAttribute('data-talvt-turn-state') !== 'complete' || !state.contains(latestUser)) continue;
      const label = Array.from(card.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (['图像生成失败', 'Image generation failed', 'Image generation failure'].includes(label)) return { ceTerminalError: 'CE_ORACLE_IMAGE_GENERATION_FAILED' };
      if (['无法加载此回复', 'Unable to load response'].includes(label)) return { ceTerminalError: 'CE_ORACLE_RESPONSE_UNAVAILABLE' };
    }
  }
  return images;
}

export function imageExpression(minTurnIndex, expectedConversationId) {
  return `(${ownedImageSnapshot.toString()})(${JSON.stringify(expectedConversationId ?? null)}, ${JSON.stringify(minTurnIndex ?? null)})`;
}
