// ============================================================================
// Popup — the only place capture is initiated  (popup/popup.js)
//
// The operator opens the popup on a funder/foundation portal page and
// clicks Capture. Only then do we inject grants-adapter.js into the page,
// read what's already on screen, and hand it to the background worker to
// POST to this repo's own grant-worker. Nothing runs on a timer or in the
// background — no automation surface here by design.
//
// If "capture a screenshot" is checked (default on — this is the whole
// point of this plugin existing separately from a DOM-only capture), a
// whole-page screenshot is taken via chrome.tabs.captureVisibleTab AFTER
// the DOM capture succeeds, and posted once per opportunity id the DOM
// capture just landed, for the grant-worker's independent vision read.
// ============================================================================

const $ = (id) => document.getElementById(id);

const settingsKeys = ['endpoint', 'token', 'withScreenshot'];

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function loadSettings() {
  const s = await chrome.storage.local.get(settingsKeys);
  $('endpoint').value = s.endpoint || '';
  $('token').value = s.token || '';
  $('with-screenshot').checked = s.withScreenshot !== false; // default on
}

async function saveSettings() {
  await chrome.storage.local.set({
    endpoint: $('endpoint').value.trim().replace(/\/+$/, ''),
    token: $('token').value.trim(),
  });
  setStatus('Settings saved.', 'ok');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function runAdapter() {
  return globalThis.AtlasGrantsAdapter?.extract?.() ?? { strategy: 'none', observations: [] };
}

async function capture() {
  const btn = $('capture');
  btn.disabled = true;
  try {
    const { endpoint, token } = await chrome.storage.local.get(['endpoint', 'token']);
    if (!endpoint || !token) {
      setStatus('Set the grant-worker URL and operator token in Settings first.', 'warn');
      return;
    }
    const withScreenshot = $('with-screenshot').checked;
    await chrome.storage.local.set({ withScreenshot });

    const tab = await activeTab();
    if (!tab) {
      setStatus('No active tab.', 'warn');
      return;
    }

    setStatus('Reading the page…');

    // 1. Inject the adapter into the page (activeTab grant from this click).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/grants-adapter.js'] });

    // 2. Run the adapter and return what it found.
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: runAdapter });
    const observations = result?.observations ?? [];
    if (!observations.length) {
      setStatus('No opportunities found on this page.\nIf this is a listing page, the portal selectors likely need tuning (see the adapter TODO).', 'warn');
      return;
    }

    setStatus(`Found ${observations.length} item(s) via ${result.strategy}. Sending…`);

    // 3. Hand off to the background worker (survives popup close).
    const resp = await chrome.runtime.sendMessage({ type: 'post-capture', observations });
    if (!resp?.ok) {
      setStatus(`Capture failed: ${resp?.error || 'unknown error'}`, 'err');
      return;
    }
    const r = resp.result || {};
    const ids = r.ids || [];
    let statusMsg = `Ingested ${r.inserted ?? 0} item(s)` +
      (r.updated ? `, updated ${r.updated}` : '') +
      (r.rejected?.length ? `, ${r.rejected.length} rejected by the gate.` : '.');

    // 4. Optional screenshot — best-effort, reported separately so a failure
    // here never reads as "the capture itself failed."
    if (withScreenshot && ids.length) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const shotResp = await chrome.runtime.sendMessage({ type: 'post-screenshot', dataUrl, opportunityIds: ids });
        statusMsg += shotResp?.ok
          ? ' Screenshot queued for vision cross-check.'
          : ` Screenshot upload failed (${shotResp?.error || 'unknown error'}) — DOM capture above still stands.`;
      } catch (err) {
        statusMsg += ` Screenshot capture failed (${err?.message || err}) — DOM capture above still stands.`;
      }
    }

    setStatus(statusMsg, 'ok');
  } catch (err) {
    setStatus('Error: ' + (err?.message || String(err)), 'err');
  } finally {
    btn.disabled = false;
  }
}

$('capture').addEventListener('click', capture);
$('save').addEventListener('click', saveSettings);
loadSettings();
