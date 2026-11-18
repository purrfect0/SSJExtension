// Selected Lucide 1.61.0 icons. See LICENSE-LUCIDE.txt for ISC and Feather MIT notices.
// All artwork is bundled with the extension; no runtime dependency or external request.
const SVG_NS = 'http://www.w3.org/2000/svg';
const spriteUrl = new URL('./sprite.svg', import.meta.url).href;

export function createIcon(name, size = 16, className = '') {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid icon name');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `ui-icon ${className}`.trim());
  svg.setAttribute('data-icon', name);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${spriteUrl}#${name}`);
  svg.appendChild(use);
  return svg;
}
