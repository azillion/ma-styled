# ma-styled sync server

A private ~60-line Cloudflare Worker + KV that keeps `masHistory`/`masMarks`
consistent across browsers (Chrome + Brave, multiple machines). Free tier is
far more than enough (a few requests per day).

## Deploy (one time, ~5 minutes)

```sh
cd server
cp wrangler.toml.example wrangler.toml   # real config is gitignored
npx wrangler login                       # opens browser, free CF account works
npx wrangler kv namespace create MAS_SYNC
#   → copy the printed id into wrangler.toml (kv_namespaces.id)
openssl rand -hex 24                     # generate your token, keep it handy
#   → stash it as SYNC_TOKEN=<token> in server/.env (gitignored) so it isn't lost
npx wrangler secret put SYNC_TOKEN       # paste the token when prompted
npx wrangler deploy
#   → note the URL, e.g. https://ma-styled-sync.<account>.workers.dev
```

## Connect a browser

Open the extension popup in each browser profile and paste the worker URL
and token into the **Sync** fields. Chrome profiles signed into the same
Google account share this via `chrome.storage.sync`; Brave needs it pasted
once per machine.

## Sanity check

```sh
curl -H "Authorization: Bearer <token>" https://<worker-url>/state
```

## Notes

- The server merges on PUT (lessons = max, units = union, decile = max,
  remaining = min, weekShown = latest), so writes are race-tolerant and
  idempotent — no revisions needed.
- Not public-facing in any meaningful sense: one route, bearer-token
  gated, stores a few KB of lesson counts.
- iPad caveat: extensions can't run there, but lessons done on the iPad
  appear in the dashboard DOM and are absorbed the next time any desktop
  browser opens /learn.
