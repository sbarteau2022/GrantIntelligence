// Grant Intelligence marketing page — the interactive pieces the design
// calls for, hand-written in vanilla JS (no build step, no framework):
//   1. The NECAI-F/990 trace: stage chips + autoplay, pauses off-screen and
//      under prefers-reduced-motion, same as the plug-in trace it echoes.
//   2. Cascade reveal-on-scroll for card grids.
//   3. Pointer-tracked tilt on the hero instrument ([data-tilt]).
// Nothing here calls a network endpoint — this is the marketing page, not
// the authenticated app; real funder lookups happen behind login.
(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) document.body.classList.add('motion-restrained');

  // ---- pointer tilt ----
  if (!reducedMotion) {
    document.querySelectorAll('[data-tilt]').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(900px) rotateX(${py * -6}deg) rotateY(${px * 6}deg)`;
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  // ---- NECAI-F / 990 trace ----
  const traceEl = document.querySelector('[data-trace]');
  if (traceEl) {
    const chips = [...traceEl.querySelectorAll('[data-stage]')];
    const views = [...traceEl.querySelectorAll('[data-trace-view]')];
    const fill = traceEl.querySelector('[data-trace-fill]');
    const panel = traceEl.querySelector('[data-trace-panel]');
    const STAGE_MS = 3200;
    let stage = 0;
    let playing = !reducedMotion;
    let timer = null;

    function render() {
      chips.forEach((c) => c.setAttribute('aria-current', String(Number(c.dataset.stage) === stage)));
      views.forEach((v) => { v.hidden = Number(v.dataset.traceView) !== stage; });
      if (fill) fill.style.width = `${((stage + 1) / views.length) * 100}%`;
    }

    function goTo(n) {
      stage = ((n % views.length) + views.length) % views.length;
      render();
    }

    function tick() { goTo(stage + 1); }

    function start() {
      stop();
      if (!playing) return;
      timer = window.setInterval(tick, STAGE_MS);
    }
    function stop() { if (timer) { window.clearInterval(timer); timer = null; } }

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        playing = false;
        stop();
        goTo(Number(chip.dataset.stage));
      });
    });

    // Pause autoplay when the trace scrolls out of view — same behavior the
    // design calls for, checked on an interval rather than requiring
    // IntersectionObserver polyfills.
    function inView() {
      const r = panel.getBoundingClientRect();
      return r.top < window.innerHeight * 0.9 && r.bottom > 0;
    }
    window.setInterval(() => {
      if (reducedMotion) return;
      if (inView() && !timer) { playing = true; start(); }
      if (!inView() && timer) { stop(); }
    }, 500);

    render();
    if (!reducedMotion) start();
  }

  // ---- cascade reveal-on-scroll ----
  const cascades = [...document.querySelectorAll('[data-cascade]')];
  function revealVisible() {
    for (const group of cascades) {
      const items = [...group.querySelectorAll('[data-cascade-item]')];
      items.forEach((item, i) => {
        if (item.classList.contains('is-visible')) return;
        const r = item.getBoundingClientRect();
        if (r.top < window.innerHeight * 0.96) {
          window.setTimeout(() => item.classList.add('is-visible'), reducedMotion ? 0 : i * 80);
        }
      });
    }
  }
  window.addEventListener('scroll', revealVisible, { passive: true });
  window.addEventListener('resize', revealVisible);
  window.setInterval(revealVisible, 400);
  revealVisible();
  // Hard safety net: content must never depend on scroll position to become
  // visible at all (a programmatic full-page capture, a mid-page deep link,
  // or a11y tooling can all leave getBoundingClientRect() reporting
  // "off-screen" even though nothing will ever scroll it into view in that
  // context). Whatever hasn't revealed itself within 2.5s reveals anyway.
  window.setTimeout(() => {
    document.querySelectorAll('[data-cascade-item]').forEach((item) => item.classList.add('is-visible'));
  }, 2500);

  // ══ THE SEARCH CONSOLE ═══════════════════════════════════════════════
  // The applicant-profile form, the tier rail, and the result renderer.
  //
  // The Worker (/api/search) decides what each tier gets and strips the
  // rest BEFORE serializing. Everything below therefore renders only what
  // it was actually handed: a field this tier doesn't get is genuinely
  // absent from the payload, and the "locked" treatment is drawn from the
  // response's own `locked_fields` list rather than from a copy of the
  // gating rules kept here. Nothing on this page can unlock anything.

  // Fallback vocabulary, used only if GET /api/tiers can't be reached (the
  // page opened as a plain file, or the Worker is down). Kept in sync with
  // src/grant-search.ts's exported constants, which are the source of truth.
  const FALLBACK = {
    tiers: [
      { id: 'basic', label: 'Basic', price: 'Free — always', resultLimit: 5,
        unlocks: ['Matched opportunities', 'Deadlines', 'Stated requirements'] },
      { id: 'supported', label: 'Supported', price: '1–3% of the award — $0 if you don’t win', resultLimit: 25,
        unlocks: ['Everything in Basic', 'Fit index with every signal named', 'What the data could not answer', 'NECAI-F donor evaluation', '990 financial overview'] },
      { id: 'full', label: 'Full service', price: '3–5%, or a retainer', resultLimit: 100,
        unlocks: ['Everything in Supported', 'Full result set', 'Proposal development end to end'] },
      { id: 'enterprise', label: 'Enterprise', price: 'Metered', resultLimit: 250,
        unlocks: ['Everything in Full service', 'Metered API access', 'Bulk profile matching'] },
    ],
    funding_bands: [
      { id: 'under-25k', label: 'Under $25,000' }, { id: '25k-100k', label: '$25,000 – $100,000' },
      { id: '100k-500k', label: '$100,000 – $500,000' }, { id: '500k-2m', label: '$500,000 – $2M' },
      { id: 'over-2m', label: 'Over $2M' },
    ],
  };

  // Entity types the form offers, split by track: a visitor picking
  // "Nonprofit" should never be shown "C-corp". Values are exactly the ids
  // src/grant-search.ts scores on — anything else is normalized to null
  // server-side and simply stops contributing to entity fit.
  const ORG_TYPES_BY_TRACK = {
    nonprofit: [
      ['501c3', '501(c)(3)'], ['fiscally-sponsored', 'Fiscally sponsored'],
      ['nonprofit-other', 'Other nonprofit'], ['tribal', 'Tribal entity'],
      ['academic', 'Academic institution'], ['public-agency', 'Public agency'],
    ],
    business: [
      ['llc', 'LLC'], ['c-corp', 'C-corp'], ['s-corp', 'S-corp'],
      ['b-corp', 'B-corp / PBC'], ['individual', 'Individual / sole proprietor'],
    ],
  };
  const STAGES = [
    ['idea', 'Idea — not yet formed'], ['early', 'Early — formed, pre-revenue or early revenue'],
    ['growth', 'Growth — established operations, scaling'], ['established', 'Established — long operating history'],
  ];
  const STATES = [
    ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],
    ['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],
    ['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],
    ['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],
    ['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],
    ['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],
    ['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],
    ['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
    ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],
    ['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
  ];

  const form = document.getElementById('profile-form');
  if (form) {
    const el = (id) => document.getElementById(id);
    const orgTypeSel = el('f-orgtype'), stateSel = el('f-state'), stageSel = el('f-stage'), needSel = el('f-need');
    const focusEl = el('f-focus'), statusEl = el('search-status'), submitEl = el('search-submit');
    const tierListEl = el('tier-list'), resultsEl = el('results');
    const countEl = el('results-count'), subEl = el('results-sub'), listEl = el('result-list');
    const lockedStrip = el('locked-strip'), lockedText = el('locked-strip-text'), lockedCta = el('locked-strip-cta');

    let tiers = FALLBACK.tiers;
    let tier = 'basic';
    let lastResponse = null;

    // Every string below reaches innerHTML, and some of it originates from
    // operator-captured funder portals (grant-observation.ts) — i.e. from
    // pages we don't control. Escape everything, without exception.
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    const money = (n) => (typeof n === 'number' && isFinite(n)
      ? `$${Math.round(n).toLocaleString('en-US')}` : null);

    function awardRange(min, max) {
      const lo = money(min), hi = money(max);
      if (lo && hi) return lo === hi ? lo : `${lo} – ${hi}`;
      if (hi) return `Up to ${hi}`;
      if (lo) return `From ${lo}`;
      return 'Not stated';
    }

    function fillSelect(sel, pairs, placeholder) {
      sel.innerHTML = `<option value="">${esc(placeholder)}</option>` +
        pairs.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
    }

    function currentTrack() {
      const checked = form.querySelector('input[name="track"]:checked');
      return checked ? checked.value : 'nonprofit';
    }

    function syncOrgTypes() {
      const previous = orgTypeSel.value;
      fillSelect(orgTypeSel, ORG_TYPES_BY_TRACK[currentTrack()], 'Prefer not to say');
      // Keep the selection only if the new track still offers it.
      if ([...orgTypeSel.options].some((o) => o.value === previous)) orgTypeSel.value = previous;
    }

    function renderTierRail() {
      tierListEl.innerHTML = tiers.map((t) => `
        <button type="button" class="tier-opt" role="radio" data-tier="${esc(t.id)}"
                aria-checked="${t.id === tier}">
          <span class="tier-opt-name">${esc(t.label)}<span class="tier-opt-cap">top ${esc(t.resultLimit)}</span></span>
          <span class="tier-opt-price">${esc(t.price)}</span>
          <ul class="tier-opt-unlocks">${(t.unlocks || []).map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
        </button>`).join('');
      tierListEl.querySelectorAll('[data-tier]').forEach((btn) => {
        btn.addEventListener('click', () => {
          tier = btn.dataset.tier;
          renderTierRail();
          // Re-run rather than re-filter: the fields another tier gets were
          // never sent to this page, so only the server can produce them.
          if (lastResponse) runSearch();
        });
      });
    }

    function readProfile() {
      return {
        track: currentTrack(),
        orgType: orgTypeSel.value || null,
        state: stateSel.value || null,
        entityStage: stageSel.value || null,
        fundingNeed: needSel.value || null,
        focus: focusEl.value.trim() || null,
      };
    }

    const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="1"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>';

    const LOCK_LABELS = {
      score: 'the fit index',
      signals: 'the signal-by-signal breakdown',
      gaps: 'what the data could not answer',
      necaif_available: 'the NECAI-F donor evaluation',
      financials: 'the funder’s 990 financials',
    };

    function renderSignals(signals) {
      return signals.map((s) => `
        <div class="signal">
          <div class="signal-row">
            <span class="signal-label">${esc(s.label)}</span>
            <span class="signal-bar"><i style="width:${Math.round(Math.max(0, Math.min(1, s.score)) * 100)}%"></i></span>
            <span class="signal-pct">${Math.round(s.score * 100)}%</span>
          </div>
          <p class="signal-detail">${esc(s.detail)}</p>
        </div>`).join('');
    }

    function renderFinancials(fin) {
      const figures = [
        ['Revenue', fin.total_revenue], ['Expenses', fin.total_expenses],
        ['Contributions received', fin.contributions_received], ['Assets, end of year', fin.total_assets_end],
      ].filter(([, v]) => typeof v === 'number');
      if (!figures.length && !fin.source_url) return '';
      return `
        <div class="fin-strip">
          <div class="card-kicker">990 FILING${fin.most_recent_filing_year ? ` · ${esc(fin.most_recent_filing_year)}` : ''}</div>
          <div class="fin-figures">
            ${figures.map(([k, v]) => `<span><b>${esc(k)}</b>${esc(money(v))}</span>`).join('')}
          </div>
          ${fin.source_url ? `<a class="fin-source" href="${esc(fin.source_url)}" target="_blank" rel="noopener noreferrer">Source: ProPublica Nonprofit Explorer ↗</a>` : ''}
        </div>`;
    }

    // `lockedFields` is passed only for the first card: the same five-item
    // sentence repeated down every result reads as a nag rather than as
    // disclosure, and the strip below the list already states it once for
    // the whole set.
    function renderResult(r, lockedFields) {
      const hasFit = Array.isArray(r.signals);
      const deadline = r.deadline_state === 'rolling' ? 'Rolling'
        : r.deadline_iso || r.deadline || 'Not stated';
      return `
        <li class="result blueprint">
          <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
          <div class="result-top">
            <div>
              <div class="result-funder">${esc(r.funder_name)}</div>
              <div class="result-program">${esc(r.program_name || 'Unnamed program')}</div>
            </div>
            <span class="result-band band-${esc(r.band)}">${esc(r.band.toUpperCase())} MATCH</span>
          </div>
          <div class="result-facts">
            <span><b>Deadline</b>${esc(deadline)}</span>
            <span><b>Award</b>${esc(awardRange(r.amount_min, r.amount_max))}</span>
            <span><b>Funder type</b>${esc(r.funder_type)}</span>
            <span><b>Listed via</b>${esc(r.source)}</span>
          </div>
          ${r.requirements ? `<p class="result-req">${esc(r.requirements)}</p>` : ''}
          ${hasFit ? `
            <div class="result-fit">
              <div class="fit-head">
                <span class="card-kicker">STRUCTURAL FIT — EVERY SIGNAL NAMED</span>
                <span class="fit-index">${Math.round(r.score * 100)}<span style="font-size:12px">/100</span></span>
              </div>
              ${renderSignals(r.signals)}
              ${r.gaps && r.gaps.length ? `
                <div class="fit-gaps">
                  <span class="card-kicker">NOT SCORED — THE DATA COULD NOT ANSWER THESE</span>
                  <ul>${r.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
                </div>` : ''}
              ${r.necaif_available ? `<div class="row" style="margin-top:var(--space-3)"><span class="tag tag-accent">NECAI-F donor evaluation available for this funder</span></div>` : ''}
            </div>` : ''}
          ${r.financials ? renderFinancials(r.financials) : ''}
          ${!hasFit && lockedFields.length ? `
            <div class="result-locked">
              ${LOCK_ICON}
              <span>Not included at this tier: ${esc(lockedFields.map((f) => LOCK_LABELS[f] || f).join(', '))}.</span>
            </div>` : ''}
        </li>`;
    }

    function renderResponse(data) {
      lastResponse = data;
      const locked = data.locked_fields || [];
      const spec = tiers.find((t) => t.id === data.tier);
      resultsEl.hidden = false;

      if (!data.results.length) {
        countEl.textContent = 'No open opportunities matched.';
        subEl.textContent = data.total_matches === 0
          ? 'Nothing in the database is open right now — this is a young corpus, not a verdict on your organization.'
          : 'Every match was filtered out as past its stated deadline.';
        listEl.innerHTML = '';
        lockedStrip.hidden = true;
      } else {
        countEl.textContent = `${data.returned} of ${data.total_matches} open ${data.total_matches === 1 ? 'opportunity' : 'opportunities'}, best structural fit first`;
        subEl.textContent = `${spec ? spec.label : data.tier} view` +
          (data.entitlement_enforced ? '' : ' · preview — every tier is open while accounts are being built') +
          '. Ranked, never recommended: the decision is yours.';
        listEl.innerHTML = data.results.map((r, i) => renderResult(r, i === 0 ? locked : [])).join('');

        const bits = [];
        if (data.withheld > 0) bits.push(`${data.withheld} more ${data.withheld === 1 ? 'match is' : 'matches are'} above this tier's cap of ${spec ? spec.resultLimit : data.returned}`);
        if (locked.length) bits.push(`the fit index, every signal behind it, the NECAI-F evaluation and 990 financials are withheld at ${spec ? spec.label : data.tier}`);
        lockedStrip.hidden = bits.length === 0;
        lockedText.textContent = bits.length
          ? `${bits.join(', and ')}. The server withholds them — they were never sent to this page.`
          : '';
      }

      el('disc-method').textContent = data.disclosure.method;
      el('disc-sources').innerHTML = data.disclosure.sources.map((s) => `<li>${esc(s)}</li>`).join('');
      el('disc-limits').innerHTML = data.disclosure.limits.map((s) => `<li>${esc(s)}</li>`).join('');
    }

    let inFlight = false;
    async function runSearch() {
      if (inFlight) return;
      inFlight = true;
      submitEl.disabled = true;
      statusEl.classList.remove('is-error');
      statusEl.textContent = 'Scoring every open opportunity against your profile…';
      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: readProfile(), tier }),
        });
        if (!res.ok) throw new Error(`search failed (HTTP ${res.status})`);
        renderResponse(await res.json());
        statusEl.textContent = '';
      } catch (err) {
        statusEl.classList.add('is-error');
        statusEl.textContent = `Could not reach the search service — ${err.message}. Nothing was submitted; try again in a moment.`;
      } finally {
        inFlight = false;
        submitEl.disabled = false;
      }
    }

    fillSelect(stateSel, STATES, 'Anywhere / prefer not to say');
    fillSelect(stageSel, STAGES, 'Prefer not to say');
    fillSelect(needSel, FALLBACK.funding_bands.map((b) => [b.id, b.label]), 'Not sure yet');
    syncOrgTypes();
    renderTierRail();
    form.querySelectorAll('input[name="track"]').forEach((r) => r.addEventListener('change', syncOrgTypes));

    // Pull the real vocabulary from the Worker so the form can never offer
    // an option the scorer doesn't understand. A failure here is silent by
    // design: the fallbacks above already render a working form, and the
    // search itself will report any real outage in its own status line.
    fetch('/api/tiers').then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data) return;
      if (Array.isArray(data.tiers) && data.tiers.length) { tiers = data.tiers; renderTierRail(); }
      if (Array.isArray(data.funding_bands) && data.funding_bands.length) {
        const keep = needSel.value;
        fillSelect(needSel, data.funding_bands.map((b) => [b.id, b.label]), 'Not sure yet');
        needSel.value = keep;
      }
    }).catch(() => {});

    form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    lockedCta.addEventListener('click', () => {
      tier = 'supported';
      renderTierRail();
      runSearch();
      document.getElementById('search').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
    });

    // ---- CTAs — every one of them lands on the console ----
    const goToConsole = () => {
      document.getElementById('search').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
    };
    document.querySelectorAll('#cta-nav, #cta-hero, #cta-footer').forEach((btn) => {
      btn.addEventListener('click', () => { goToConsole(); focusEl.focus({ preventScroll: true }); });
    });

    // The pricing cards ARE the tier picker: clicking one selects that tier
    // in the console, so "what does Supported actually get me" is answered
    // against the visitor's own organization rather than in the abstract.
    document.querySelectorAll('[data-tier-jump]').forEach((card) => {
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => {
        tier = card.dataset.tierJump;
        renderTierRail();
        goToConsole();
        if (lastResponse) runSearch();
      });
    });
  }
})();
