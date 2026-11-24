// Finds article links in raw wikitext, in reading order, to judge how easy a
// link is to spot.

import { normalizeTitle } from '../util/titles.js';

// Namespaces and sister-project prefixes; [[File:...]] and the like aren't articles.
const NON_ARTICLE_PREFIXES = new Set(
  (
    'file image media category template wikipedia wp help portal draft module user talk ' +
    'special mediawiki timedtext book wikt wiktionary w commons s wikisource q wikiquote n ' +
    'wikinews b wikibooks v wikiversity voy wikivoyage species d wikidata m meta mw phab c f'
  ).split(' '),
);

function stripNoise(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>/]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
}

// Returns unique link targets in order, and how many of them are in the lead.
export function extractLinks(wikitext) {
  const text = stripNoise(wikitext ?? '');
  const firstHeading = text.search(/\n==[^=]/);
  const leadChars = firstHeading === -1 ? text.length : firstHeading;

  const links = [];
  const seen = new Set();
  let leadEnd = 0;
  const re = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;
  for (let m; (m = re.exec(text)); ) {
    const target = m[1].split('#')[0].trim();
    if (!target || target.startsWith(':')) continue;
    const colon = target.indexOf(':');
    if (colon > 0) {
      const prefix = target.slice(0, colon).trim();
      // Language links are lowercase ([[fr:Paris]]); "It: Chapter Two" is an article.
      if (NON_ARTICLE_PREFIXES.has(prefix.toLowerCase()) || /^[a-z]{2,3}(-[a-z]+)?$/.test(prefix)) {
        continue;
      }
    }
    const t = normalizeTitle(target);
    if (seen.has(t)) continue;
    seen.add(t);
    links.push(t);
    if (m.index < leadChars) leadEnd = links.length;
  }
  return { links, leadEnd };
}

// How easy it is to spot the link to `names` (a page and its redirects), 0..1.
// Lead links score 0.6 to 1 and body links 0.25 to 0.85, earlier is better.
// A link missing from the wikitext comes from a template such as a navbox at
// the bottom of the page, and scores 0.15.
export function clickScore({ links, leadEnd }, names) {
  const wanted = new Set(names.map(normalizeTitle));
  const i = links.findIndex((l) => wanted.has(l));
  if (i === -1) return { score: 0.15, inLead: false, viaTemplate: true };
  const early = links.length <= 1 ? 1 : 1 - i / (links.length - 1);
  const inLead = i < leadEnd;
  return { score: inLead ? 0.6 + 0.4 * early : 0.25 + 0.6 * early, inLead, viaTemplate: false };
}
