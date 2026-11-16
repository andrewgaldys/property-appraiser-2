/**
 * Tiny DOM builder. All string children become text nodes, so values that come from
 * the tax roll (owner names, addresses) can never inject markup.
 */
export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Element.append that skips null/false children (conditional sections). */
export function appendAll(el: Element, ...children: Child[]): void {
  append(el, children);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Record<string, string> = {
  close: 'M4 4l8 8M12 4l-8 8',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  link: 'M6.5 9.5l3-3M7 4.8l1.2-1.2a2.5 2.5 0 013.5 3.5L10.5 8.3M9 11.2l-1.2 1.2a2.5 2.5 0 01-3.5-3.5L5.5 7.7',
  print: 'M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2M4.5 9.5h7v4h-7z',
  fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  focus: 'M8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2',
  filters: 'M2.5 4h11M4.5 8h7M6.5 12h3',
  arrow: 'M6 3.5L10.5 8 6 12.5',
  chevron: 'M4.5 6.25L8 9.75l3.5-3.5',
  search: 'M7 2.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM10.4 10.4l3.1 3.1',
  download: 'M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9',
  back: 'M10 3.5L5.5 8l4.5 4.5',
  save: 'M4.5 2.5h7v11L8 10.5l-3.5 3z',
  info: 'M8 2a6 6 0 110 12A6 6 0 018 2zM8 7.2v4M8 4.9v.2',
  legend: 'M2.5 4.5h2M6.5 4.5h7M2.5 8h2M6.5 8h7M2.5 11.5h2M6.5 11.5h7',
  warn: 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.2v.2',
  pin: 'M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 10-9 0C3.5 9.8 8 14 8 14zM8 5.2a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6z',
  external: 'M7 3.5H3.5v9h9V9M9.5 2.5h4v4M13.5 2.5L7.5 8.5',
  help: 'M8 2a6 6 0 110 12A6 6 0 018 2zM6.3 6.4a1.8 1.8 0 113 1.3c-.7.5-1.3.9-1.3 1.8M8 11.5v.2',
  check: 'M3.5 8.5l3 3 6-7',
  user: 'M8 8a2.6 2.6 0 100-5.2A2.6 2.6 0 008 8zM3 13.5c.5-2.3 2.5-3.6 5-3.6s4.5 1.3 5 3.6',
  layers: 'M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8.2L8 11.2l5.5-3M2.5 10.8L8 13.8l5.5-3',
  spark: 'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2',
  chart: 'M3 13.5V9M8 13.5V2.5M13 13.5V6',
};

export function icon(name: keyof typeof ICONS | string, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** A link to another site: opens a new tab and passes neither the opener nor the referrer. */
export function extLink(url: string, attrs?: Attrs | null, ...children: Child[]): HTMLAnchorElement {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', ...attrs }, ...children);
}

/** A small "copy this" icon button that confirms with a toast. */
export function copyButton(text: string, what: string): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'icon-btn sm',
      title: `Copy ${what}`,
      'aria-label': `Copy ${what}`,
      onclick: (e: Event) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(
          () => toast(`Copied ${what}`),
          () => undefined,
        );
      },
    },
    icon('copy', 13),
  );
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function toast(message: string, ms = 2600): void {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const t = h('div', { class: 'toast' }, message);
  host.append(t);
  window.setTimeout(() => t.classList.add('out'), ms);
  window.setTimeout(() => t.remove(), ms + 400);
}
