import type { DataStore } from '../data';
import { appendAll, clear, extLink, h, icon, type Child } from '../dom';
import {
  STATE_LABEL,
  STATE_TIP,
  confidenceLabel,
  howText,
  officersFirst,
  roleLabel,
  sunbizRecordUrl,
  typeLabel,
  yearsSince,
  type EntityMatch,
  type EntityState,
  type Principal,
} from '../entities';
import { shortDate } from '../format';
import type { Manifest } from '../types';
import { infoTip } from './infotip';

const date = (iso: string | null): string => (iso ? shortDate(iso) : '');

/** Status chip: the word always, a mark for the states worth a second look. */
export function stateChip(state: EntityState, compact = false): HTMLElement {
  return h(
    'span',
    { class: `ent-state s-${state}${compact ? ' sm' : ''}`, title: STATE_TIP[state] },
    state === 'A' ? null : icon('warn', compact ? 12 : 13),
    STATE_LABEL[state],
  );
}

export interface EntityBlockOptions {
  /** Shown after a principal who links this owner to others (a button to them). */
  linked?: (p: Principal) => Child;
}

/** One state business record: status, type, filing and reports, principals, and how it was matched. */
export function entityBlock(m: EntityMatch, manifest: Manifest, opts: EntityBlockOptions = {}): HTMLElement {
  const { rec, link } = m;
  const src = manifest.entities!;
  const asOf = src.as_of;
  const age = yearsSince(rec.filed, asOf);
  // [label, value, sub, value is words (not a figure)]
  const facts: [string, Child, Child?, boolean?][] = [];
  if (rec.filed) facts.push(['Filed', date(rec.filed), age != null ? `${age === 0 ? 'under a year' : `${age} ${age === 1 ? 'year' : 'years'}`} ago` : null]);
  if (rec.state === 'O') {
    facts.push(['Annual report', `None for ${asOf.slice(0, 4)}`, rec.reportYear ? `last filed for ${rec.reportYear}` : 'none on file']);
  } else if (rec.reportYear) {
    facts.push(['Last annual report', String(rec.reportYear), rec.reportDate ? `filed ${date(rec.reportDate)}` : null]);
  }
  if (rec.note && rec.state !== 'O') {
    facts.push(rec.state === 'A' ? ['Reinstated', date(rec.noteDate) || 'Yes'] : ['Status change', rec.note, date(rec.noteDate), true]);
  }
  facts.push(['Document number', rec.doc]);

  const people = officersFirst(rec.principals);
  return h(
    'div',
    { class: 'ent' },
    h(
      'div',
      { class: 'ent-top' },
      stateChip(rec.state),
      h('span', { class: 'ent-type' }, typeLabel(rec.type)),
      src.demo ? h('span', { class: 'ent-demo', title: 'Synthetic data for a layout check: not a real record' }, 'Sample') : null,
    ),
    h('p', { class: 'ent-name' }, rec.name),
    h(
      'dl',
      { class: 'facts ent-facts' },
      facts.map(([k, v, sub, words]) =>
        h('div', { class: 'fact' }, h('dt', null, k), h('dd', { class: words ? 'txt' : null }, v, sub ? h('small', null, sub) : null)),
      ),
    ),
    people.length
      ? h(
          'ul',
          { class: 'ent-people', 'aria-label': 'Officers, managers and registered agent' },
          people.map((p) =>
            h(
              'li',
              { class: p.role === 'RA' ? 'ra' : null },
              h(
                'span',
                { class: 'ent-who' },
                h('b', null, p.name),
                h('span', { class: 'ent-meta' }, [roleLabel(p.role), p.addr].filter(Boolean).join(' · ')),
              ),
              p.group ? opts.linked?.(p) ?? null : null,
            ),
          ),
        )
      : h('p', { class: 'cap' }, 'No officers or managers in the state’s data file.'),
    rec.more ? h('p', { class: 'cap' }, 'More than six officers are on file: Sunbiz lists them all.') : null,
    rec.addr || rec.mail
      ? h(
          'p',
          { class: 'cap ent-addrs' },
          rec.addr ? h('span', null, 'Principal address: ', rec.addr) : null,
          rec.mail && rec.mail !== rec.addr ? h('span', null, 'Mailing address: ', rec.mail) : null,
        )
      : null,
    h(
      'p',
      { class: 'cap ent-match' },
      h('b', null, confidenceLabel(link.conf)),
      `: ${howText(link.how)}. `,
      `${src.label} data as of ${date(src.file_date)}.`,
      infoTip(
        'state business record',
        'Matched by the app from the Division of Corporations’ quarterly data files, by name (and mailing address where it agrees). A possible match can be the wrong company with a similar name: check it on Sunbiz before relying on it.',
      ),
    ),
    h(
      'div',
      { class: 'lookups compact' },
      extLink(
        sunbizRecordUrl(rec.name),
        { class: 'btn ghost sm ext', title: 'Open this company’s record on sunbiz.org (new tab)' },
        icon('external', 13),
        'Verify on Sunbiz',
      ),
    ),
  );
}

/**
 * The parcel panel's state-record block, loaded once per parcel (re-renders of the same parcel keep
 * it). `badge` sits next to the owner name and shows a status worth a second look.
 */
export class EntityCard {
  readonly el = h('div', { class: 'ent-wrap' });
  readonly badge = h('span', { class: 'ent-badge' });
  private pid: string | null = null;
  private token = 0;

  constructor(
    private data: DataStore,
    private manifest: Manifest,
    private opts: EntityBlockOptions = {},
  ) {}

  get enabled(): boolean {
    return !!this.manifest.entities;
  }

  show(pid: string, fallback: () => Child): HTMLElement {
    if (pid === this.pid) return this.el;
    this.pid = pid;
    const t = ++this.token;
    clear(this.el);
    clear(this.badge);
    this.el.append(h('div', { class: 'dr-loading sm' }, h('span', { class: 'spinner' }), 'Checking state business records'));
    const done = (m: EntityMatch | null) => {
      if (t !== this.token) return;
      clear(this.el);
      if (m) {
        this.el.append(entityBlock(m, this.manifest, this.opts));
        if (m.rec.state !== 'A') this.badge.append(stateChip(m.rec.state, true));
      } else {
        appendAll(this.el, fallback());
      }
    };
    this.data.entityFor(pid).then(done, () => done(null));
    return this.el;
  }

  reset(): void {
    this.pid = null;
    this.token++;
  }
}
