import { WikiClient, findRoute, titleToUrl } from '../index.js';
import { attachAutocomplete } from './autocomplete.js';
import { renderGraph, routeThrough } from './graph.js';
import * as text from './text.js';

const client = new WikiClient();
const $ = (selector, root = document) => root.querySelector(selector);
const form = $('#search-form');
const goButton = $('#go');
const outcome = $('#outcome');
const inputs = { start: $('#start'), end: $('#end') };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function setInvalid(which, invalid) {
  inputs[which].closest('.field').toggleAttribute('data-invalid', invalid);
}

// Form

const completers = {};
for (const which of ['start', 'end']) {
  const list = $(`#${which}-options`);
  const suggest = (q, signal) => client.suggest(q, signal);
  completers[which] = attachAutocomplete(inputs[which], list, suggest);
  inputs[which].addEventListener('input', () => setInvalid(which, false));
}

for (const button of document.querySelectorAll('[data-random]')) {
  button.addEventListener('click', async () => {
    const which = button.dataset.random;
    button.disabled = true;
    try {
      const [title] = await client.random(1);
      inputs[which].value = title ?? '';
      setInvalid(which, false);
    } catch {
      showMessage(text.errorCopy({}));
    } finally {
      button.disabled = false;
    }
  });
}

let controller = null;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (controller) {
    controller.abort();
    return;
  }
  const start = inputs.start.value.trim();
  const end = inputs.end.value.trim();
  const empty = !start ? 'start' : !end ? 'end' : null;
  if (empty) {
    setInvalid(empty, true);
    showMessage(text.errorCopy({ code: 'empty' }));
    inputs[empty].focus();
    return;
  }
  completers.start.cancel();
  completers.end.cancel();
  search(start, end);
});

// Searching

async function search(start, end) {
  controller = new AbortController();
  goButton.textContent = 'Stop';
  goButton.classList.add('stop');
  const names = { start, end };
  const view = showSearching(names);

  try {
    const result = await findRoute(client, start, end, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'resolved') Object.assign(names, { start: p.start, end: p.end });
        view.update(p, names);
      },
    });
    await view.finish();
    showResult(result);
  } catch (err) {
    if (err.code !== 'cancelled') console.error(err);
    const copy = text.errorCopy(err, { start, end });
    if (copy.field) setInvalid(copy.field, true);
    showMessage(copy);
  } finally {
    controller = null;
    goButton.textContent = 'Find the route';
    goButton.classList.remove('stop');
  }
}

function showSearching(names) {
  const top = h('span', { className: 'trail-line seg-top', ariaHidden: 'true' });
  const bottom = h('span', { className: 'trail-line seg-bottom', ariaHidden: 'true' });
  const startName = h('div', { className: 'end-name top', textContent: names.start });
  const endName = h('div', { className: 'end-name bottom', textContent: names.end });
  const doing = h('span', { textContent: 'Looking up both articles…' });
  const count = h('span');
  const lede = h('p', { className: 'lede quiet', textContent: 'Searching…' });
  const section = h(
    'div',
    { className: 'searching' },
    lede,
    h(
      'div',
      { className: 'trail' },
      h('span', { className: 'gap', ariaHidden: 'true' }),
      top,
      bottom,
      h('span', { className: 'dot top', ariaHidden: 'true' }),
      h('span', { className: 'dot bottom', ariaHidden: 'true' }),
      startName,
      endName,
      h('p', { className: 'status' }, doing, h('br'), count),
    ),
  );
  outcome.replaceChildren(section);

  // Each finished level covers half the remaining distance, so the two lines
  // close in on the middle but only join when the search really meets.
  const reach = (levels) => 0.9 * (0.08 + 0.92 * (1 - 0.5 ** levels));
  let statusChangedAt = 0;

  return {
    update(p, { start, end }) {
      startName.textContent = start;
      endName.textContent = end;
      if (p.phase === 'search') {
        const partial = p.step === 'expanding' && p.total ? p.done / p.total : 0;
        const f = p.fwdLevel + (p.side === 'forward' ? partial : 0);
        const b = p.bwdLevel + (p.side === 'backward' ? partial : 0);
        top.style.height = `calc((50% - 20px) * ${reach(f)})`;
        bottom.style.height = `calc((50% - 20px) * ${reach(b)})`;
        const pages = p.fwdVisited + p.bwdVisited;
        count.textContent = `${pages.toLocaleString('en')} page${pages === 1 ? '' : 's'} found`;
      }
      // Batches finish quickly; hold each sentence long enough to read.
      const now = performance.now();
      const status = text.searchStatus(p, { start, end });
      if (status && (p.done === 0 || p.phase !== 'search' || now - statusChangedAt > 700)) {
        doing.textContent = status;
        statusChangedAt = now;
      }
    },
    finish() {
      section.classList.add('met');
      lede.textContent = 'Found it.';
      return new Promise((resolve) => setTimeout(resolve, reducedMotion.matches ? 0 : 650));
    },
  };
}

// Result

let shown = null;

function showResult(result) {
  shown = {
    result,
    titles: result.best?.titles ?? [result.start],
    summaries: new Map(Object.entries(result.summaries)),
    allOpen: false,
  };
  drawResult({ reveal: true });
}

const sameRoute = (a, b) => a.join('\u0000') === b.join('\u0000');

function drawResult({ reveal = false } = {}) {
  const { result, titles, summaries, allOpen } = shown;
  const picked = result.best && !sameRoute(titles, result.best.titles);

  const steps = titles.map((title, i) => {
    const isEnd = i === 0 || i === titles.length - 1;
    return h(
      'li',
      {},
      h('span', { className: isEnd ? 'dot' : 'dot small', ariaHidden: 'true' }),
      h('a', {
        className: 'step-title',
        href: titleToUrl(title),
        target: '_blank',
        rel: 'noopener',
        textContent: title,
      }),
      h('div', { className: 'step-desc', textContent: text.stepDescription(summaries.get(title)) }),
    );
  });

  const note = h('p', { className: 'note' }, text.routeNote(result, { picked }));
  if (picked) {
    note.append(' ', linkButton('Back to the best one', () => setRoute(result.best.titles)));
  } else if (result.totalRoutes > 1 && !allOpen) {
    const label = `See all ${text.numberWord(result.totalRoutes)}`;
    note.append(' ', linkButton(label, () => toggleAll(true)));
  }

  const section = h(
    'div',
    { className: reveal ? 'reveal' : '' },
    h('p', { className: 'lede', textContent: text.clicksLede(result.clicks) }),
    h(
      'div',
      { className: 'trail' },
      titles.length > 1
        ? h('span', { className: 'trail-line route-line', ariaHidden: 'true' })
        : null,
      h('ol', { className: 'route' }, ...steps),
    ),
    note,
    allOpen ? allRoutes() : null,
  );
  outcome.replaceChildren(section);
  fitRouteLine();
}

const linkButton = (label, onclick) =>
  h('button', { type: 'button', className: 'link-button', textContent: label, onclick });

// Run the red line from the centre of the first dot to the centre of the last.
function fitRouteLine() {
  const trail = $('.outcome .trail');
  const line = trail && $('.route-line', trail);
  if (!line) return;
  const dots = trail.querySelectorAll('.route .dot');
  const box = trail.getBoundingClientRect();
  const first = dots[0].getBoundingClientRect();
  const last = dots[dots.length - 1].getBoundingClientRect();
  line.style.top = `${first.top + first.height / 2 - box.top}px`;
  line.style.bottom = `${box.bottom - (last.top + last.height / 2)}px`;
}
addEventListener('resize', fitRouteLine);
document.fonts?.ready.then(fitRouteLine);

function allRoutes() {
  const { result } = shown;
  const box = h('div', { className: 'graph-scroll' });
  const { truncated, nodes, fullNodeCount } = result.graph;
  const count = (n) => n.toLocaleString('en');
  const pickHint = 'Pick any page to take the route through it.';
  const hint = truncated
    ? `Showing ${count(nodes.length)} of ${count(fullNodeCount)} pages. ${pickHint}`
    : pickHint;
  requestAnimationFrame(() => renderGraph(box, result.graph, shown.titles, pickThrough));
  return h(
    'section',
    { className: 'all-routes' },
    h(
      'div',
      { className: 'all-head' },
      h('h2', { textContent: `All ${text.numberWord(result.totalRoutes)} routes` }),
      linkButton('Hide', () => toggleAll(false)),
    ),
    box,
    h('p', { className: 'note graph-hint', textContent: hint }),
  );
}

function toggleAll(open) {
  shown.allOpen = open;
  drawResult();
  if (open) {
    const behavior = reducedMotion.matches ? 'auto' : 'smooth';
    $('.all-routes', outcome).scrollIntoView({ behavior, block: 'nearest' });
  }
}

function pickThrough(title) {
  const ranked = shown.result.routes.find((r) => r.titles.includes(title));
  setRoute(ranked ? ranked.titles : routeThrough(shown.result.graph, title, shown.titles));
}

async function setRoute(titles) {
  shown.titles = titles;
  drawResult();
  const missing = titles.filter((t) => !shown.summaries.has(t));
  if (!missing.length) return;
  try {
    for (const [title, summary] of await client.summaries(missing)) {
      shown.summaries.set(title, summary);
    }
    if (shown?.titles === titles) drawResult();
  } catch {
    // The route still works without descriptions.
  }
}

// Messages

function showMessage({ message, hint, quiet }) {
  shown = null;
  outcome.replaceChildren(
    h('p', { className: quiet ? 'message quiet' : 'message', textContent: message }),
    ...(hint ? [h('p', { className: 'note', textContent: hint })] : []),
  );
}
