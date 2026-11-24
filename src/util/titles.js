// MediaWiki treats underscores as spaces and the first letter as uppercase.
export function normalizeTitle(raw) {
  const t = String(raw ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const first = String.fromCodePoint(t.codePointAt(0));
  return first.toUpperCase() + t.slice(first.length);
}

export function titleToUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
