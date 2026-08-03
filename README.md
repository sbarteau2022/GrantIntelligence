# GrantIntelligence

The Grant Intelligence Suite's public surface: a Cloudflare static Worker
serving `public/` — the marketing page now, the authenticated app UI later.

- **Design system**: "Industry" (steel-blue wireframe — `public/assets/industry.css`
  is the verbatim token sheet from the design handoff; `site.css` is page layout
  on top of it, no hard-coded values the tokens already carry).
- **No build step**: plain HTML/CSS/vanilla JS, deployed as static assets.
- **Backend**: the engine itself (fit analysis, NECAI-F evaluations, 990
  overviews) lives in elle-worker (`/api/elle-grants`), not here.

## Layout

```
public/
  index.html         marketing page markup
  assets/
    industry.css      design-system tokens (source of truth for the look)
    site.css          page layout on top of the tokens
    app.js            vanilla JS: NECAI-F/990 trace, cascade reveal, hero tilt
wrangler.jsonc         assets-only Worker config (serves public/)
package.json           npm scripts (dev, deploy) + wrangler devDependency
```

## Getting started

```bash
npm install
npm run dev      # local preview
npm run deploy   # wrangler deploy (assets-only Worker)
```
