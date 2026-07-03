// MA Styled — private sync server (Cloudflare Worker + KV)
//
// One document, one owner. PUT /state merges the incoming snapshot into
// the stored one with monotonic rules and returns the result, so a single
// round-trip is both push and pull, and concurrent browsers can't clobber
// each other. GET /state returns the stored document.
//
// Auth: Authorization: Bearer <SYNC_TOKEN> (a wrangler secret).

function mergeState(a, b) {
  const history = { ...(a.history ?? {}) };
  for (const [key, incoming] of Object.entries(b.history ?? {})) {
    const cur = history[key] ?? {};
    const r = Math.min(cur.r ?? Infinity, incoming.r ?? Infinity);
    history[key] = {
      l: Math.max(cur.l ?? 0, incoming.l ?? 0),
      ...(isFinite(r) ? { r } : {}),
    };
  }

  const am = a.marks ?? {};
  const bm = b.marks ?? {};
  const decile = Math.max(am.decile ?? -1, bm.decile ?? -1);

  // voyage entries and currentCourse carry timestamps — newest wins,
  // which makes un-charting propagate instead of resurrecting
  const voyage = { ...(am.voyage ?? {}) };
  for (const [slug, entry] of Object.entries(bm.voyage ?? {})) {
    if (!voyage[slug] || (entry.t ?? 0) > (voyage[slug].t ?? 0)) voyage[slug] = entry;
  }
  const currentCourse =
    [am.currentCourse, bm.currentCourse]
      .filter(Boolean)
      .sort((x, y) => (x.t ?? 0) - (y.t ?? 0))
      .pop() ?? null;

  const marks = {
    init: !!(am.init || bm.init),
    units: [...new Set([...(am.units ?? []), ...(bm.units ?? [])])],
    decile: decile === -1 ? null : decile,
    weekShown: [am.weekShown, bm.weekShown].filter(Boolean).sort().pop() ?? null,
    voyage,
    currentCourse,
  };

  return { history, marks };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (request.headers.get('Authorization') !== `Bearer ${env.SYNC_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);
    if (url.pathname !== '/state') {
      return json({ error: 'not found' }, 404);
    }

    const stored = JSON.parse((await env.KV.get('state')) ?? '{"history":{},"marks":null}');

    if (request.method === 'GET') return json(stored);

    if (request.method === 'PUT') {
      let incoming;
      try {
        incoming = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      // ?mode=replace: repair escape hatch — the monotonic merge can never
      // lower a value, so corrupted history needs a verbatim overwrite
      const merged =
        url.searchParams.get('mode') === 'replace' ? incoming : mergeState(stored, incoming);
      await env.KV.put('state', JSON.stringify(merged));
      return json(merged);
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
