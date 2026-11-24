// Breaking ties between equally short routes. Each signal is 0..1:
//   popularity  - daily readers of the pages in between (log scale)
//   relatedness - share of steps where the next page links back
//   human       - how early each link appears in its article
// A missing signal (null) is left out of the weighted average.

export const DEFAULT_WEIGHTS = { popularity: 0.4, relatedness: 0.3, human: 0.3 };

// 10 views a day is about 0.2, 1,000 about 0.6, 100,000 or more is 1.
export const popularityOf = (views = 0) => Math.min(1, Math.log10(views + 1) / 5);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function blend(features, weights = DEFAULT_WEIGHTS) {
  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (features[key] == null || !weight) continue;
    total += weight * features[key];
    weightSum += weight;
  }
  return weightSum ? total / weightSum : 0;
}

// `linksBack` is a Set of "to\0from" pairs; `clicks` maps "from\0to" to a
// clickScore. Either can be null when it hasn't been measured.
export function describeRoute(titles, { views, linksBack, clicks }, weights) {
  const middle = titles.slice(1, -1);
  const hops = titles.slice(1).map((to, i) => {
    const from = titles[i];
    return {
      from,
      to,
      linksBack: linksBack ? linksBack.has(`${to}\u0000${from}`) : null,
      click: clicks?.get(`${from}\u0000${to}`) ?? null,
    };
  });
  const features = {
    popularity: middle.length ? mean(middle.map((t) => popularityOf(views?.get(t)))) : null,
    relatedness: linksBack && hops.length ? mean(hops.map((h) => (h.linksBack ? 1 : 0))) : null,
    human:
      clicks && hops.length && hops.every((h) => h.click)
        ? mean(hops.map((h) => h.click.score))
        : null,
  };
  return { titles, hops, features, score: blend(features, weights) };
}
