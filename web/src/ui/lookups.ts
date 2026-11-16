import { extLink, h, icon } from '../dom';
import { entityKind, entityLabel, ownerLookups } from '../entity';

/** Owner-type badge read from the name. Names that do not say (cut-off company names) get none. */
export function entityBadge(name: string | null | undefined): HTMLElement | null {
  const label = entityLabel(name);
  return label
    ? h('span', { class: 'badge entity-badge', title: 'Read from the owner name on the tax roll, not from state records' }, label)
    : null;
}

/**
 * Links to Florida's state business records (Sunbiz) for an owner name: the entity itself, or for
 * a person the companies that list them. `county` (the parcel's) tells which way round the roll
 * writes people's names; `compact` shows only the most useful link.
 */
export function lookupRow(name: string | null | undefined, county?: number, compact = false): HTMLElement | null {
  if (entityKind(name) === 'gov') {
    return compact ? null : h('p', { class: 'cap' }, 'Government owners are not registered with the Division of Corporations.');
  }
  const links = ownerLookups(name, county).slice(0, compact ? 1 : 2);
  if (!links.length) return null;
  return h(
    'div',
    { class: `lookups${compact ? ' compact' : ''}` },
    links.map((l, i) =>
      extLink(
        l.url,
        { class: `btn ${i === 0 ? 'ghost' : 'quiet'} sm ext`, title: `${l.title}. Opens sunbiz.org in a new tab.` },
        icon('external', 13),
        l.label,
      ),
    ),
  );
}

/** One small icon link (tables and lists), or null when there is nothing to look up. */
export function lookupIcon(name: string | null | undefined, county?: number): HTMLElement | null {
  const l = ownerLookups(name, county)[0];
  return l
    ? extLink(
        l.url,
        { class: 'icon-btn sm ext', title: `${l.label} (opens sunbiz.org)`, 'aria-label': `${l.label}: ${name ?? ''}`, onclick: (e: Event) => e.stopPropagation() },
        icon('external', 13),
      )
    : null;
}
