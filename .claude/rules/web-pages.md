---
paths:
  - "src/web/**"
  - "src/account.ts"
  - "src/account-data.ts"
  - "src/admin.ts"
  - "src/landing.ts"
---

# Rendered pages

- Pages ship zero JavaScript and every one sends `script-src 'none'`. An inline handler such as
  `onsubmit=` is blocked by that CSP, so build the interaction as a plain form post. Adding JS
  means revisiting the CSP on purpose, not per page.
- Build every form action and link as an absolute `PUBLIC_URL`-based URL. The server runs behind a
  prefix-stripping reverse proxy, so a relative or Host-derived URL points at the wrong path.
- The account editor mirrors the MCP tool rules: `main` is undeletable, open-item statuses are
  open/done/dismissed, routine statuses active/paused/retired, and section/reference/routine saves
  carry the `updated_at` optimistic-concurrency token so a browser save can't clobber a concurrent
  coaching-session write. An overwrite here calls `logReplace` like the tools do.
- `/admin` is English-only and returns 404 to anyone not in `ADMIN_EMAILS`.
- Shared look (design tokens, dark mode, site nav) lives in `src/web/layout.ts`; the sticky EN/DE
  language preference in `src/web/i18n.ts`.
