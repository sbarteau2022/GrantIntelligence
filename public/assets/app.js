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

  // ---- CTAs — placeholder targets until the authenticated app exists ----
  document.querySelectorAll('#cta-nav, #cta-hero, #cta-footer').forEach((btn) => {
    btn.addEventListener('click', () => { window.location.hash = '#necaif'; });
  });
})();
