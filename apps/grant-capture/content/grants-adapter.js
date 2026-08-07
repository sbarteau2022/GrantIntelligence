// ============================================================================
// Grants adapter  (content/grants-adapter.js)
//
// Ported from RAPIDAi's apps/atlas-capture/content/grants-adapter.js — same
// extraction logic, now feeding this repo's own grant-worker directly
// instead of RAPIDAi's ingestion worker ("Rapid is not ingesting grants,
// the grant worker is").
//
// Injected into the active tab ONLY when the operator clicks Capture (see
// popup/popup.js). Reads whatever opportunity listing is already rendered
// on the small-funder/foundation portal page the operator is looking at.
// Does not navigate, does not touch credentials or cookies, never runs on
// its own.
//
// Grant portals are arbitrary small-foundation/state-program websites with
// no shared markup. Two extraction strategies:
//   1. SELECTORS — precise, portal-specific. STUBBED: fill these in per
//      portal from the live DOM (right-click a listing → Inspect) once
//      you've found one worth tuning for repeat visits.
//   2. HEURISTIC — generic scan for repeated card/row-like elements that
//      pair a title-looking heading with a dollar-amount-looking string; a
//      nearby date-looking string becomes the deadline.
//
// The server-side gate (grant-worker's src/grant-observation.ts) is the
// source of truth — it re-validates and de-dupes everything this returns.
// ============================================================================

(() => {
  // ---- 1. Portal-specific selectors — TODO: fill in per portal you tune ----
  const SELECTORS = {
    CARD: null,
    FUNDER_NAME: null,
    PROGRAM_NAME: null,
    AMOUNT: null,
    DEADLINE: null,
    ELIGIBILITY: null,
  };

  const AMOUNT_RE = /\$\s*[\d,]+(?:\.\d+)?\s*(?:[kKmMbB])?\b|\bvaries\b|\bup to\b/i;
  const DATE_RE = /\b(?:20\d{2}|rolling|ongoing|open|fy\d{2})\b/i;

  function text(el) {
    return el && el.textContent ? el.textContent.trim() : '';
  }

  function pageDefaultFunderName() {
    return (document.title || location.hostname).split(/[|–—-]/)[0].trim() || location.hostname;
  }

  function extractWithSelectors(doc, observedAt, portalContext) {
    if (!SELECTORS.CARD || !SELECTORS.PROGRAM_NAME) return [];
    const out = [];
    const defaultFunder = pageDefaultFunderName();
    for (const card of doc.querySelectorAll(SELECTORS.CARD)) {
      const programName = text(card.querySelector(SELECTORS.PROGRAM_NAME));
      if (!programName) continue;
      out.push({
        funderName: SELECTORS.FUNDER_NAME ? text(card.querySelector(SELECTORS.FUNDER_NAME)) || defaultFunder : defaultFunder,
        programName,
        amountText: SELECTORS.AMOUNT ? text(card.querySelector(SELECTORS.AMOUNT)) : null,
        deadlineText: SELECTORS.DEADLINE ? text(card.querySelector(SELECTORS.DEADLINE)) : null,
        eligibilityText: SELECTORS.ELIGIBILITY ? text(card.querySelector(SELECTORS.ELIGIBILITY)) : null,
        portalContext,
        captureMethod: 'dom',
        observedAt,
      });
    }
    return out;
  }

  // Generic fallback: any heading-bearing block (card, list item, table row)
  // whose text contains both something title-like and, ideally, a dollar
  // amount or a deadline-looking token becomes a candidate opportunity.
  function extractHeuristic(doc, observedAt, portalContext) {
    const out = [];
    const defaultFunder = pageDefaultFunderName();
    const blocks = doc.querySelectorAll('article, li, .card, [class*="grant"], [class*="opportunity"], [class*="program"], tr');
    const seen = new Set();

    for (const block of blocks) {
      const heading = block.querySelector('h1, h2, h3, h4, a, strong, td, th');
      const programName = text(heading);
      if (!programName || programName.length < 4 || programName.length > 200) continue;
      if (seen.has(programName)) continue;

      const blockText = text(block);
      const amountMatch = blockText.match(AMOUNT_RE);
      const dateMatch = blockText.match(DATE_RE);
      if (!amountMatch && !dateMatch) continue;

      seen.add(programName);
      out.push({
        funderName: defaultFunder,
        programName,
        amountText: amountMatch ? amountMatch[0] : null,
        deadlineText: dateMatch ? dateMatch[0] : null,
        eligibilityText: null,
        portalContext,
        captureMethod: 'dom',
        observedAt,
      });
    }
    return out;
  }

  globalThis.AtlasGrantsAdapter = {
    matches() {
      return true; // arbitrary small-funder portals — no fixed domain
    },
    extract(doc = document) {
      const observedAt = new Date().toISOString();
      const portalContext = location.href;
      const viaSelectors = extractWithSelectors(doc, observedAt, portalContext);
      if (viaSelectors.length) return { strategy: 'selectors', observations: viaSelectors };
      const viaHeuristic = extractHeuristic(doc, observedAt, portalContext);
      return { strategy: 'heuristic', observations: viaHeuristic };
    },
  };
})();
