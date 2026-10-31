// Synthetic, offline DOM fixture. It never connects to a browser or provider.
export class Element {
  constructor(tag, attributes = {}, children = []) {
    this.tagName = tag; this.attributes = attributes; this.children = children;
    this.parentElement = null; this.hidden = false;
    for (const child of children) child.parentElement = this;
  }
  getAttribute(key) { return this.attributes[key] ?? null; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  matches(selector) {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (s === 'main' || s === 'img') return this.tagName === s;
      if (s.startsWith('form button')) return false;
      const m = s.match(/^\[([^\]$^=]+)(?:(\$=|\^=|=)"([^"]*)")?\]$/);
      if (!m) return false;
      const value = this.getAttribute(m[1]);
      return value !== null && (!m[2] || (m[2] === '=' ? value === m[3] : m[2] === '$=' ? value.endsWith(m[3]) : value.startsWith(m[3])));
    });
  }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) {
    return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  contains(other) { return this === other || this.children.some(c => c.contains(other)); }
  compareDocumentPosition(other) {
    let root = this; while (root.parentElement) root = root.parentElement;
    const preorder = n => [n, ...n.children.flatMap(preorder)];
    const nodes = preorder(root); return nodes.indexOf(other) > nodes.indexOf(this) ? 4 : 2;
  }
}
export function modernFixture() {
  const image = new Element('img');
  Object.assign(image, { src: 'blob:https://chatgpt.com/synthetic-image', alt: '已生成图像 1', complete: true, naturalWidth: 1254, naturalHeight: 1254 });
  const user = new Element('div', { 'data-chatgpt-search-unit-key': 'fixture:0:user' }, [new Element('div', { 'data-content-search-unit-key': 'fixture:0:user' })]);
  const gallery = new Element('div', { 'data-testid': 'generated-image-gallery' }, [new Element('button', { 'data-testid': 'generated-image-preview' }, [image])]);
  const complete = new Element('div', { 'data-talvt-turn-state': 'complete' }, [user, gallery]);
  const turn = new Element('div', { 'data-turn-key': 'synthetic-exchange' }, [complete]);
  const main = new Element('main', {}, [turn]);
  const document = new Element('document', {}, [main]);
  return { document, main, turn, complete, user, gallery, image, location: { origin: 'https://chatgpt.com', pathname: '/c/synthetic-conversation' } };
}
