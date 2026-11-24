# Rabbit Hole

Find the shortest way from one Wikipedia article to another, using only links.

Type two articles and Rabbit Hole finds the route with the fewest clicks. There
are usually several routes of that length, so it picks the one that reads best:
well-known pages, steps that link back to each other, links near the top of
the article.

It runs entirely in the browser and talks to Wikipedia's public API directly.
There is no server and nothing to install.

## Running it

ES modules don't load from `file://`, so serve the folder:

```
npm run dev
```

and open http://localhost:5173. Any static server works, for example
`python -m http.server 5173`.

Tests need Node 21 or later and use a fake Wikipedia, so they run offline:

```
npm test
```

## How it works

**Search.** A breadth-first search runs from both ends at once: forward along
the links on each page, and backward along the links pointing at the
destination. Each step expands a whole level of whichever side is cheaper, and
every parent is recorded, so when the two sides meet the result contains every
shortest route, not just the first one found. Redirects are resolved as the
search goes, so a link to "USA" counts as reaching "United States". Searches
stop after six clicks or two minutes.

**Picking a route.** Each tied route gets three scores between 0 and 1, which
are blended with weights 0.4, 0.3 and 0.3:

- popularity: average daily views of the pages in between
- relatedness: how many steps link back to the previous page
- ease of clicking: how early each link appears in its article

Popular pairs can tie thousands of times, so scoring narrows down in stages:
page views for the whole graph, link-back checks for the top 150 routes, and
link positions for the top 12. The winner is the best of that shortlist.

## Layout

```
index.html                 the page
styles/app.css
src/ui/                    page logic, autocomplete, route graph, interface text
src/engine/bfs.js          the two-way search
src/engine/find-route.js   scoring pipeline
src/engine/dag.js          route counting and k-best routes
src/api/wiki-client.js     MediaWiki API client: batching, continuation, retries
test/                      tests against a fake Wikipedia
scripts/serve.mjs          small static server for development
```

The search is checked against a plain one-way BFS on 400 random link graphs,
including redirects and broken links.
