# News Carousel Top Comments Coverage — Design

**Date:** 2026-05-21
**Repos affected:** `read-api` (this repo), `reddzit-refresh` (frontend, sibling repo at `../reddzit/`)

## Problem

In the news carousel (default `/news` view), top comments appear on the first ~7 slides and then disappear for the remaining ~43 slides. The image and headline still render, but the right-side "Top comments" panel is empty.

`curl https://read-api.reddzit.com/api/trending/rss?topic=news` returns 50 posts: indices 0–6 each have 5 `topComments`; indices 7–49 have none. The cliff is deterministic (`cached: false` in the response).

**Root cause:** `services/rssService.js:289` sets `TOP_COMMENT_TARGET_COUNT = 7` and `services/rssService.js:467` only hydrates `posts.slice(0, 7)` with comments. The cap was originally chosen to bound the Reddit API call burst during a cold rebuild of the aggregated feed.

## Goals

- Most posts in the carousel show top comments without requiring users to wait through a noticeable fetch state.
- Cold rebuild of `/api/trending/rss` stays well under Reddit's 100 req/min OAuth ceiling, even with multiple cache keys expiring near-simultaneously.
- The long-tail posts (slides past the inline cap) get comments on demand without re-architecting caching.

## Non-Goals

- Replacing the in-memory caches with Redis (CLAUDE.md policy: single-server + LRU is the standard until multi-server).
- Comment threading, deeper depth, or scoring beyond what `getTopComments` already returns.
- Backfilling comments for trending posts ahead of time via a cron job.

## Approach: Hybrid (inline 25 + lazy endpoint for 26–50)

Two complementary changes:

1. **Raise the inline hydration cap from 7 → 25.** This covers the typical viewing window most users will scroll through. Cold-rebuild cost stays bounded.
2. **Add a per-post lazy endpoint.** Posts past the inline cap fetch comments on demand from the client as the user scrolls into the long tail, with a small prefetch window.

### Why hybrid (vs. all-50 inline or pure lazy)

- **All 50 inline** would burst ~56 Reddit calls per cold rebuild. With 3+ cache keys expiring in the same minute (topic=news, topic=less-political, default mix, plus single-sub views), that's >150 calls/min — over Reddit's 100/min OAuth ceiling.
- **Pure lazy** would put every slide through a client-side fetch, adding latency and a visible loading state to slides users see most often (0–24). The existing `topCommentsCache` (LRU 2000, 1h TTL) would still absorb most calls, but the UX cost is real.
- **Hybrid 25 + lazy** caps cold-rebuild burst at ~30 calls (fits 3 concurrent rebuilds within budget) and pushes long-tail cost into the user's interaction timeline, where it's amortized by the per-post cache. Cross-key cache hits (e.g., the same post appearing in `topic=news` and `r/worldnews`) keep real call volume well below worst case.

### Reddit API budget

| Cap | Cold rebuild calls | Concurrent rebuilds before risk |
|-----|--------------------|----------------------------------|
| 7 (current) | ~12 | 8+ |
| 25 (proposed) | ~30 | 3 |
| 50 | ~56 | 1–2 |

Lazy endpoint calls are spread by user behavior and gated by the 1h `topCommentsCache`. The existing `redditService.isApiRestricted` circuit breaker already short-circuits to `null` on 401/403/429, so degradation is graceful — worst-case we just don't show comments for some posts, which is the existing behavior today.

## Backend changes (`read-api`)

### 1. `services/rssService.js`

- Change `TOP_COMMENT_TARGET_COUNT` from `7` to `25`.
- Update the docblock at line 293 (currently "first 7 posts").
- Add bounded concurrency to the comment fan-out:
  - Install `p-limit` (small dep, no transitive deps).
  - At module scope: `const commentLimit = pLimit(10);`
  - At the fan-out site (line ~468), wrap each call: `targets.map((post) => commentLimit(() => getTopComments(...)))`.

### 2. New endpoint in `server.js`

`GET /api/trending/posts/:id/top-comments`

- **Validation:** `:id` must match `^[a-z0-9]{4,10}$` (Reddit base-36 post id shape). Reject with 400 otherwise.
- **Handler:**
  - Look up OAuth token via `getAppOnlyAccessToken()` (same path the trending endpoint uses).
  - Call `rssService.getTopComments('t3_' + id, { prisma, accessToken })`.
  - Return `{ comments: TrendingPostTopComment[] }`. Use empty array when result is `null` (no comments / rate-limited / fetch failure). Never 5xx for missing comments.
- **Headers:** `Cache-Control: public, max-age=300` (5 min). The 1h server-side LRU is the real cache; the HTTP header is for CDN/browser benefit.
- **Auth:** none. Same posture as `/api/trending/rss` — app-only token used internally.
- **Placement in `server.js`:** adjacent to the `/api/trending/rss` route (~line 252) for discoverability.

### 3. Dependency

Add `p-limit` to `package.json` (latest 5.x). It's ESM-only in newer versions; if that conflicts with the CommonJS-style of this repo, pin to the latest CommonJS-compatible release (~3.1.0). Verify at implementation time.

## Frontend changes (`../reddzit/`)

### 1. `src/helpers/DailyService.ts`

Add a new helper:

```ts
async getTopCommentsForPost(postId: string): Promise<TrendingPostTopComment[]> {
  try {
    const response = await axios.get<{ comments: TrendingPostTopComment[] }>(
      `${API_BASE_URL}/api/trending/posts/${encodeURIComponent(postId)}/top-comments`,
      { timeout: 8000 }
    );
    return response.data?.comments ?? [];
  } catch {
    return [];
  }
}
```

### 2. Comment-fetch coordinator in the trending page

The carousel itself is a dumb display component reading `post.topComments`. The lazy fetching lives in the parent page that owns the posts array (where `NewsCarousel` is rendered with the `onVisibleRangeChange` callback already wired). To be confirmed at implementation: locate the parent (likely `src/pages/News.tsx` or `src/pages/Daily.tsx`).

In that parent:

- Maintain state: `const [lazyComments, setLazyComments] = useState<Record<string, TrendingPostTopComment[]>>({})`
- Maintain in-flight set (ref to avoid re-renders): `const inFlight = useRef<Set<string>>(new Set())`
- Replace the `onVisibleRangeChange` handler (or augment the existing one) with logic that, for each currently visible index `i`:
  - Computes the prefetch target indices: `i`, `i+1`, `i+2` (clamped to `posts.length - 1`).
  - For each target index past the inline cap threshold (25, hard-coded mirror of backend constant — acceptable since changing it requires coordinated deploy anyway): if the post is missing `topComments` AND no entry in `lazyComments` AND not in `inFlight`, fire `DailyService.getTopCommentsForPost(post.id)`. On resolve, write to `lazyComments`.
- Build the `posts` array passed to `NewsCarousel`: `posts.map(p => p.topComments ? p : (lazyComments[p.id] ? { ...p, topComments: lazyComments[p.id] } : p))`.

The carousel's existing `onVisibleRangeChange` emits `[prev, current, next]` (a 3-element window with `prev` and `next` computed via modulo). The parent can ignore `prev` (we don't prefetch behind) and add `current+2` itself, since the parent has access to `index` via the emitted set — extract `current` by sorting the indices and picking the middle / current one (or restructure: have the carousel emit `currentIndex` separately, but that's a bigger API change; first-pass uses the existing signal).

**Simpler alternative considered:** extend `NewsCarousel`'s emit to `[current, current+1, current+2]` for slides ≥ 24. Rejected because it changes the existing contract used by `SavedFeed` for image previews. The parent computing its own window is cleaner.

## Acceptance criteria

- `GET /api/trending/rss?topic=news` returns up to 25 posts with `topComments` populated; at least 80% of the first 25 posts have ≥ 3 displayable comments after the client `isDisplayableComment` filter.
- `GET /api/trending/posts/:id/top-comments` exists, returns `{ comments: TrendingPostTopComment[] }`, and is exercised by the news carousel for slides 26+.
- In the carousel, top comments display for slides 26+ within at most one swipe of arrival (prefetch window of current+2 makes the typical case zero-latency).
- p95 latency of `/api/trending/rss` cold rebuild does not regress beyond ~500ms compared to the current 7-post baseline. The additional 18 parallel comment calls, gated by `p-limit(10)`, should fit within roughly two Reddit round-trips.
- No sustained increase in Reddit 429 / circuit-breaker activations in the first week post-deploy (`apiStatus` table records circuit-breaker state — verify after deploy).

## Open implementation questions (resolve during plan)

- Exact filename of the parent page that renders `NewsCarousel` (verify in `reddzit/src/pages/`).
- Whether to install `p-limit@5.x` (ESM) or `p-limit@3.x` (CJS). The codebase uses `require()`, suggesting CJS — pin to 3.1.0 unless ESM interop is already wired.
- Whether to expose the inline-cap threshold (25) as a shared constant in `DailyService.ts` and import from there in the parent page, to keep the frontend's "skip threshold" tied to the backend's actual behavior. Recommended.

## Out of scope (future iterations)

- Prefetching slide `current-1` (backwards swipe). Map-keyed cache makes this trivial to add later.
- A WebSocket / SSE push of comment updates for the active slide (overkill for current scale).
- Backfilling comments via a cron job ahead of the user request. The current cache architecture already does most of this passively via cross-key reuse.
