import { h, icon, type Child } from '../dom';

/**
 * ⓘ buttons with a small popover: explanations live here instead of always-visible paragraphs.
 * One shared popover (role="tooltip"), shown on hover or keyboard focus, pinned open by a click
 * or tap, closed by Escape, a second click or a click elsewhere. Content is built from text nodes.
 */
let pop: HTMLElement | null = null;
let owner: HTMLButtonElement | null = null;
let pinned = false;

function popover(): HTMLElement {
  if (!pop) {
    pop = h('div', { id: 'infotip', class: 'infotip', role: 'tooltip', hidden: true });
    document.body.append(pop);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pop && !pop.hidden) hide(true);
    });
    document.addEventListener('pointerdown', (e) => {
      if (pinned && owner && !owner.contains(e.target as Node) && !pop!.contains(e.target as Node)) hide(true);
    });
    window.addEventListener('resize', () => hide(true));
    document.addEventListener('scroll', () => hide(true), true);
  }
  return pop;
}

function place(btn: HTMLElement, el: HTMLElement): void {
  const r = btn.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const gap = 8;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  let y = r.bottom + gap;
  if (y + hgt > window.innerHeight - 8) y = Math.max(8, r.top - hgt - gap);
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function show(btn: HTMLButtonElement, content: () => Child[], pin = false): void {
  const el = popover();
  el.replaceChildren(...content().map((c) => (c instanceof Node ? c : document.createTextNode(String(c ?? '')))));
  el.hidden = false;
  if (owner && owner !== btn) owner.removeAttribute('aria-describedby');
  owner = btn;
  pinned = pin;
  btn.setAttribute('aria-describedby', 'infotip');
  btn.setAttribute('aria-expanded', String(pin));
  place(btn, el);
}

function hide(force = false): void {
  if (!pop || (pinned && !force)) return;
  pop.hidden = true;
  owner?.removeAttribute('aria-describedby');
  owner?.setAttribute('aria-expanded', 'false');
  owner = null;
  pinned = false;
}

/**
 * An ⓘ button. `text` is plain text: paragraphs separated by blank lines become separate blocks;
 * pass a function to build it lazily (e.g. from state that changes).
 */
export function infoTip(label: string, text: string | (() => string)): HTMLButtonElement {
  const content = (): Child[] => {
    const t = typeof text === 'function' ? text() : text;
    return t.split(/\n\s*\n/).map((p) => h('p', null, p.trim()));
  };
  const btn = h(
    'button',
    { type: 'button', class: 'info', 'aria-label': `About ${label}`, 'aria-expanded': 'false' },
    icon('info', 14),
  ) as HTMLButtonElement;
  btn.addEventListener('mouseenter', () => {
    if (!pinned) show(btn, content);
  });
  btn.addEventListener('mouseleave', () => hide());
  btn.addEventListener('focus', () => {
    if (!pinned) show(btn, content);
  });
  btn.addEventListener('blur', () => hide());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation(); // never toggles a surrounding <details> / label
    if (pinned && owner === btn) hide(true);
    else show(btn, content, true);
  });
  return btn;
}
