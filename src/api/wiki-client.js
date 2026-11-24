// Client for the MediaWiki Action API. Requests go through a `transport`
// function so the tests can swap in a fake Wikipedia.

import { createLimiter, sleep, abortError } from '../util/limiter.js';
import { chunk, normalizeTitle } from '../util/titles.js';

function httpTransport({ host = 'en.wikipedia.org', userAgent } = {}) {
  const endpoint = `https://${host}/w/api.php`;
  return async (params, signal) => {
    const query = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*' });
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== false) {
        query.set(key, Array.isArray(value) ? value.join('|') : String(value));
      }
    }
    // Wikimedia asks API clients to identify themselves, but browsers can't set
    // User-Agent and this header costs a CORS preflight, so it's opt-in.
    const headers = userAgent ? { 'Api-User-Agent': userAgent } : undefined;
    const res = await fetch(`${endpoint}?${query}`, { signal, headers });
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        status: res.status,
        retryAfter: Number(res.headers.get('retry-after')) || 0,
      });
    }
    return res.json();
  };
}

const RETRYABLE_API_ERRORS = new Set(['maxlag', 'ratelimited']);

function isRetryable(err) {
  if (err.code) return RETRYABLE_API_ERRORS.has(err.code);
  return err.status === undefined || err.status === 429 || err.status >= 500;
}

export class WikiClient {
  constructor({ transport = httpTransport(), concurrency = 6, maxRetries = 4 } = {}) {
    this.transport = transport;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.limit = createLimiter(concurrency);
    this.stats = { requests: 0, retries: 0 };
  }

  request(params, signal) {
    return this.limit(async () => {
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw abortError();
        try {
          this.stats.requests++;
          const json = await this.transport({ maxlag: 5, ...params }, signal);
          if (json?.error) {
            const { code, info } = json.error;
            throw Object.assign(new Error(`${code}: ${info}`), { code });
          }
          return json;
        } catch (err) {
          if (err.name === 'AbortError' || signal?.aborted) throw abortError();
          if (attempt >= this.maxRetries || !isRetryable(err)) throw err;
          this.stats.retries++;
          const wait = err.retryAfter ? err.retryAfter * 1000 : 400 * 2 ** attempt;
          await sleep(wait + Math.random() * 200, signal);
        }
      }
    });
  }

  // Runs a query through all of its continuations and merges the pages.
  // `page(title)` follows normalisation and redirects to the page a title
  // landed on.
  async query(params, signal, { maxRounds = Infinity } = {}) {
    const pages = new Map();
    const renamed = new Map();
    let last = {};
    let cont = {};
    for (let round = 1; ; round++) {
      const json = await this.request({ action: 'query', ...params, ...cont }, signal);
      last = json.query ?? {};
      for (const { from, to } of [...(last.normalized ?? []), ...(last.redirects ?? [])]) {
        renamed.set(from, to);
      }
      for (const p of last.pages ?? []) mergePage(pages, p);
      if (!json.continue || round >= maxRounds) break;
      cont = json.continue;
    }
    const resolve = (title) => {
      let t = title;
      for (let i = 0; i < 5 && renamed.has(t); i++) t = renamed.get(t);
      return t;
    };
    return { pages, resolve, page: (title) => pages.get(resolve(title)), last };
  }

  // Runs one query per batch of titles, in parallel, and maps every requested
  // title through `pick(page, title, result)`.
  async perTitle(titles, batchSize, params, pick, signal, onBatch) {
    const out = new Map();
    await Promise.all(
      chunk(titles, batchSize).map(async (batch) => {
        const r = await this.query({ ...params, titles: batch }, signal);
        for (const t of batch) out.set(t, pick(r.page(t), t, r));
        onBatch?.(batch.length);
      }),
    );
    return out;
  }

  // Continuations within a batch run one after another, so link queries use
  // enough batches to keep every connection busy.
  linkBatchSize(count) {
    return Math.max(1, Math.min(50, Math.ceil(count / this.concurrency)));
  }

  async resolve(input, signal) {
    const title = normalizeTitle(input);
    const r = await this.query({ titles: title, redirects: 1 }, signal);
    const page = r.page(title);
    return {
      title: page?.title ?? title,
      missing: !page || Boolean(page.missing || page.invalid) || page.ns !== 0,
    };
  }

  // Article links on each page. Redirects are followed, so asking for "USA"
  // returns the links of "United States".
  outLinks(titles, signal, onBatch) {
    return this.perTitle(
      titles,
      this.linkBatchSize(titles.length),
      { prop: 'links', plnamespace: 0, pllimit: 'max', redirects: 1 },
      (page, title, r) => ({
        canonical: r.resolve(title),
        links: (page?.links ?? []).map((l) => l.title),
      }),
      signal,
      onBatch,
    );
  }

  // Articles linking to each page, with redirects to it listed separately.
  // Redirects are not followed: asking for a redirect returns what links
  // through it.
  inLinks(titles, signal, onBatch) {
    return this.perTitle(
      titles,
      this.linkBatchSize(titles.length),
      { prop: 'linkshere', lhprop: ['title', 'redirect'], lhnamespace: 0, lhlimit: 'max' },
      (page) => {
        const links = [];
        const redirects = [];
        for (const l of page?.linkshere ?? []) (l.redirect ? redirects : links).push(l.title);
        return { links, redirects };
      },
      signal,
      onBatch,
    );
  }

  redirectsOf(titles, signal) {
    return this.perTitle(
      titles,
      50,
      { prop: 'redirects', rdnamespace: 0, rdlimit: 'max' },
      (page) => (page?.redirects ?? []).map((r) => r.title),
      signal,
    );
  }

  // Roughly how many articles link to `title`. One search call; null if the
  // search is unavailable.
  async backlinkCount(title, signal) {
    try {
      const r = await this.query(
        {
          list: 'search',
          srsearch: `linksto:"${title.replace(/"/g, '')}"`,
          srnamespace: 0,
          srlimit: 1,
          srinfo: 'totalhits',
          srprop: '',
        },
        signal,
        { maxRounds: 1 },
      );
      return r.last.searchinfo?.totalhits ?? null;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return null;
    }
  }

  // Average daily views over the last `days` days.
  pageviews(titles, signal, days = 30) {
    return this.perTitle(
      titles,
      50,
      { prop: 'pageviews', pvipdays: days, redirects: 1 },
      (page) => {
        const counts = Object.values(page?.pageviews ?? {}).filter((v) => typeof v === 'number');
        return counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
      },
      signal,
    );
  }

  // Which `from -> to` links exist, checked for every pair of the two lists.
  // Returns a Set of "from\0linked title".
  async linkPairs(fromTitles, toTitles, signal) {
    const found = new Set();
    const jobs = [];
    for (const from of chunk(fromTitles, 50)) {
      for (const to of chunk(toTitles, 50)) {
        const params = { prop: 'links', pltitles: to, pllimit: 'max', redirects: 1 };
        jobs.push(
          this.perTitle(from, 50, params, (page) => page?.links ?? [], signal).then((res) => {
            for (const [t, links] of res) for (const l of links) found.add(`${t}\u0000${l.title}`);
          }),
        );
      }
    }
    await Promise.all(jobs);
    return found;
  }

  wikitext(titles, signal) {
    return this.perTitle(
      titles,
      10,
      { prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: 1 },
      (page) => page?.revisions?.[0]?.slots?.main?.content ?? '',
      signal,
    );
  }

  summaries(titles, signal) {
    return this.perTitle(
      titles,
      20,
      {
        prop: ['description', 'extracts'],
        exintro: 1,
        explaintext: 1,
        exsentences: 2,
        exlimit: 20,
        redirects: 1,
      },
      (page, title) => ({
        title: page?.title ?? title,
        description: page?.description ?? '',
        extract: page?.extract ?? '',
      }),
      signal,
    );
  }

  async suggest(prefix, signal, limit = 8) {
    const search = prefix.trim();
    if (!search) return [];
    const r = await this.query(
      {
        generator: 'prefixsearch',
        gpssearch: search,
        gpsnamespace: 0,
        gpslimit: limit,
        prop: 'description',
        redirects: 1,
      },
      signal,
      { maxRounds: 1 },
    );
    return [...r.pages.values()]
      .sort((a, b) => a.index - b.index)
      .map((p) => ({ title: p.title, description: p.description ?? '' }));
  }

  async random(count, signal) {
    const r = await this.query(
      { list: 'random', rnnamespace: 0, rnfilterredir: 'nonredirects', rnlimit: count },
      signal,
      { maxRounds: 1 },
    );
    return (r.last.random ?? []).map((p) => p.title);
  }
}

// Continuations repeat a page with more of its data; join the lists.
function mergePage(pages, page) {
  const prev = pages.get(page.title);
  if (!prev) {
    pages.set(page.title, { ...page });
    return;
  }
  for (const [key, value] of Object.entries(page)) {
    if (Array.isArray(value)) prev[key] = (prev[key] ?? []).concat(value);
    else if (value && typeof value === 'object') prev[key] = { ...prev[key], ...value };
    else if (value !== undefined) prev[key] = value;
  }
}
