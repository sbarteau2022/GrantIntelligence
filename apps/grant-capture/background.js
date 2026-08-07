// ============================================================================
// Background service worker — authenticated delivery  (background.js)
//
// Kept separate from the popup so requests survive the popup closing. Holds
// no logic beyond authenticated delivery to this repo's own grant-worker —
// no RAPIDAi endpoint anywhere in this file, by design ("Rapid is not
// ingesting grants, the grant worker is; it needs its own atlas browser
// plugin as well").
//
// Two message types:
//   'post-capture'    — the DOM observations from grants-adapter.js
//   'post-screenshot' — an optional whole-page screenshot, POSTed once per
//                        opportunity id the DOM capture just landed, so the
//                        grant-worker's multimodal-intake.ts can run an
//                        independent vision read to cross-check the DOM
//                        parse against. Best-effort: a screenshot upload
//                        failure never undoes the DOM capture that already
//                        succeeded — the two are reported to the operator
//                        separately.
//
// The operator token lives in chrome.storage.local. Anything shipped in an
// extension is extractable, so treat this as a revocable, low-privilege
// credential — never anything with account-wide Cloudflare access.
// ============================================================================

async function postObservations(observations) {
  const { endpoint, token } = await chrome.storage.local.get(['endpoint', 'token']);
  if (!endpoint || !token) {
    return { ok: false, error: 'missing endpoint or token — set them in Settings' };
  }
  let res;
  try {
    res = await fetch(`${endpoint}/internal/atlas-observation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ observations }),
    });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) return { ok: false, error: body?.error || `HTTP ${res.status}`, result: body };
  return { ok: true, result: body };
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function postScreenshot(dataUrl, opportunityIds) {
  const { endpoint, token } = await chrome.storage.local.get(['endpoint', 'token']);
  if (!endpoint || !token) return { ok: false, error: 'missing endpoint or token' };
  const bytes = dataUrlToBytes(dataUrl);

  const results = [];
  for (const id of opportunityIds) {
    try {
      const res = await fetch(`${endpoint}/internal/visual-capture?opportunity_id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` },
        body: bytes,
      });
      const body = await res.json().catch(() => ({}));
      results.push({ id, ok: res.ok, error: res.ok ? undefined : body?.error || `HTTP ${res.status}` });
    } catch (err) {
      results.push({ id, ok: false, error: String(err?.message || err) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, results, error: failed.length ? `${failed.length}/${results.length} screenshot upload(s) failed` : undefined };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'post-capture') {
    postObservations(msg.observations || []).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'post-screenshot') {
    postScreenshot(msg.dataUrl, msg.opportunityIds || []).then(sendResponse);
    return true;
  }
  return false;
});
