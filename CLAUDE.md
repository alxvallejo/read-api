# CLAUDE.md

Project context for AI-assisted development on the Reddzit read-api.

## Project Overview

Backend API for Reddzit, a Reddit content curation app. Express + Prisma + PostgreSQL. Runs on PM2 in production, nodemon in dev.

- **Frontend repo**: `../reddzit-refresh/` (Vite + React + TypeScript)
- **Admin dashboard**: Frontend `/admin` route, protected by `X-Admin-Password` and `X-Reddit-Username` headers
- **Deploy**: GitHub Actions (`.github/workflows/deploy-read-api.yml`) builds, tarballs, SCPs to server, runs Prisma migrate, restarts PM2

## Credential & API Key Usage

All secrets live in `.env` (local) or the server's `/var/www/read-api/.env` (production). Never committed to git.

### Reddit OAuth (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET)

Two usage patterns:

1. **App-only token** (your credentials, counts against your rate limit):
   - `services/redditService.js` — `getAccessToken()`, `fetchReddit()`, `fetchRedditWithStatusTracking()`, `performHealthCheck()`
   - `controllers/redditProxyController.js` — `getAppOnlyAccessToken()`, `getByIdPublic()`
   - `server.js` — `fetchRedditPublic()` (share preview OG tags)
   - `jobs/generateHourlyReport.js` — `getPopularSubreddits()`

2. **User token pass-through** (user's own Bearer token forwarded, does NOT use your credentials):
   - `controllers/redditProxyController.js` — `getMe()`, `getSaved()`, `unsave()`, `save()`, `getById()`, `getUserSubreddits()`

3. **OAuth exchange** (one-time per login/refresh, uses your credentials):
   - `controllers/redditProxyController.js` — `oauthToken()`, `oauthRefresh()`

### Other Keys

- `OPENAI_API_KEY` — `services/llmService.js`, `controllers/forYouController.js`
- `RESEND_API_KEY` — `services/emailService.js`
- `DATABASE_URL` — 18+ files via Prisma and pg Pool
- `ADMIN_PASSWORD` / `ADMIN_USERNAMES` — `controllers/adminController.js`

## Share Preview Caching Architecture

Share links (`/p/:fullname` and `/p/:fullname/:slug`) generate OG/Twitter meta tags so social platforms show rich previews. These routes previously hit Reddit's API on every request, which is a rate-limit risk if links go viral.

### Caching layers

**Layer 1 — In-memory LRU cache** (`server.js`):
- Uses `lru-cache` (already a dependency) with 500 max entries and 1-hour TTL
- `fetchRedditPublic()` checks `postCache` before hitting Reddit's API
- Cache hits/misses tracked via `cacheStats` counter object
- Post metadata (title, thumbnail, selftext) is effectively immutable, so aggressive caching is safe
- Resets on server restart (acceptable — one API call per unique post to rebuild)

**Layer 2 — HTTP Cache-Control header**:
- Both share preview routes return `Cache-Control: public, max-age=3600`
- Social media crawlers, CDNs, and browsers cache the full HTML response for 1 hour
- If a CDN (e.g., Cloudflare) is placed in front of the app, this header is respected automatically

**Layer 3 (future, if needed) — CDN**:
- No code changes needed — the Cache-Control headers from Layer 2 are already CDN-friendly
- Would absorb viral traffic at edge locations before it reaches the server

### Monitoring

- `GET /api/admin/cache-stats` (admin-protected) returns `{ size, max, hits, misses, hitRate }`
- Frontend admin dashboard (`Admin.tsx`) displays a "Share Preview Cache" card with hit rate progress bar and stats
- Hit rate color coding: green >= 70%, yellow >= 40%, red below

### Why not Redis?

Single-server setup (PM2). In-memory LRU is faster and requires no additional infrastructure. If the app ever goes multi-server, PostgreSQL (already available) would serve as a shared cache before Redis would be needed.

## Cron Jobs

Background jobs in `jobs/` run via PM2. They use app-only Reddit tokens and count against the rate limit. Managed through the admin dashboard Jobs tab.

- `SKIP_REDDIT_COMMENTS=true` in `.env` reduces API calls by skipping comment fetching

## GitHub Actions Deploy

The workflow sources `/var/www/read-api/.env` on the server for `DATABASE_URL` (needed by Prisma migrate). Secrets are never passed from GitHub Actions to the SSH session — they stay on the server.
