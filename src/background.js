// MA Styled — sync relay.
// The content script sends its state here; we PUT it to the private sync
// server (which merges and returns the combined state) and hand the
// result back. Unconfigured or offline → respond null, extension stays
// fully local.

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== 'mas-sync') return;
  (async () => {
    const { syncUrl, syncToken } = await chrome.storage.sync.get({
      syncUrl: '',
      syncToken: '',
    });
    if (!syncUrl || !syncToken) return respond(null);

    const base = syncUrl.replace(/\/+$/, '').replace(/\/state$/, '');
    const res = await fetch(`${base}/state${msg.replace ? '?mode=replace' : ''}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${syncToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ history: msg.history, marks: msg.marks }),
      signal: AbortSignal.timeout(6000),
    });
    respond(res.ok ? await res.json() : null);
  })().catch(() => respond(null));
  return true; // async response
});
