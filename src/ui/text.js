// Everything the interface says.

const WORDS = 'zero one two three four five six seven eight nine ten'.split(' ');

export const numberWord = (n) => WORDS[n] ?? n.toLocaleString('en');
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clicks = (n) => `${numberWord(n)} click${n === 1 ? '' : 's'}`;

export function clicksLede(n) {
  return n === 0 ? 'Same article.' : `${capitalise(clicks(n))}.`;
}

const REASONS = {
  popularity: 'goes through the best-known pages',
  relatedness: 'has steps that link back to each other',
  human: 'uses links that are easy to spot',
};

// The signal that contributed most to the best route's score.
function reason({ features }, weights) {
  const [best] = Object.keys(REASONS)
    .filter((key) => features[key] != null)
    .sort((a, b) => features[b] * weights[b] - features[a] * weights[a]);
  return REASONS[best] ?? 'reads best';
}

export function routeNote(result, { picked }) {
  const { clicks: n, totalRoutes, start, end, best, weights } = result;
  if (n === 0) return 'Pick two different articles to find a route between them.';
  if (n === 1) return `${start} links straight to ${end}.`;
  if (totalRoutes === 1) return 'The only route this short.';
  const count = `One of ${numberWord(totalRoutes)} routes this short.`;
  if (picked) return `${count} This is one you picked.`;
  return `${count} This one ${reason(best, weights)}.`;
}

export function searchStatus(p, { start, end }) {
  if (p.phase === 'resolve') return 'Looking up both articles…';
  if (p.phase === 'score') return 'Found the shortest routes. Picking the best one…';
  if (p.phase !== 'search' || p.step !== 'expanding') return '';
  const pages = `${p.total.toLocaleString('en')} pages`;
  if (p.side === 'forward') {
    if (p.fwdLevel === 0) return `Reading ${start}`;
    return `Reading the ${pages} ${clicks(p.fwdLevel)} from ${start}`;
  }
  return p.bwdLevel === 0
    ? `Finding pages that link to ${end}`
    : `Finding what links to the ${pages} ${clicks(p.bwdLevel)} before ${end}`;
}

export function errorCopy(err, { start, end } = {}) {
  switch (err.code) {
    case 'empty':
      return { message: 'Type an article in both fields.', quiet: true };
    case 'cancelled':
      return { message: 'Search stopped.', quiet: true };
    case 'not-found': {
      const which = err.details.which;
      return {
        message: `There’s no Wikipedia article called “${which === 'end' ? end : start}”.`,
        hint: 'Check the spelling, or pick one of the suggestions as you type.',
        field: which,
      };
    }
    case 'no-path':
      return {
        message: 'There’s no route between these two.',
        hint:
          err.details.side === 'forward'
            ? `Following links out of ${start} never leads anywhere new.`
            : `The few articles that lead to ${end} can’t be reached from ${start}.`,
      };
    case 'depth-limit':
      return { message: 'No route within six clicks.', hint: 'Try a different destination.' };
    case 'timeout':
      return {
        message: 'This one took too long, so the search stopped after two minutes.',
        hint: 'Pages with few links in or out are slow to reach. Try a better-known destination.',
      };
    case 'too-big':
      return {
        message: 'This search grew too big to finish in the browser.',
        hint: 'Try a more specific pair of articles.',
      };
    default:
      return {
        message: 'Couldn’t reach Wikipedia.',
        hint: 'Check your connection and try again.',
      };
  }
}

// Wikipedia's short description, or else the first sentence of the article.
export function stepDescription(summary) {
  if (!summary) return '';
  if (summary.description) return capitalise(summary.description);
  const first = summary.extract.split(/(?<=[.!?])\s/)[0];
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}
