# News Carousel Top Comments Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make top comments display on most posts (slides 0–24 inline, 25–49 lazy-loaded) in the news carousel instead of only the first 7.

**Architecture:** Hybrid approach across two repos. Backend (`read-api`) raises inline hydration from 7→25 with bounded concurrency and adds a new `GET /api/trending/posts/:id/top-comments` endpoint. Frontend (`reddzit`, at `../reddzit/`) lazy-fetches comments via this endpoint for slides ≥ 25 with a current+2 prefetch window driven by the carousel's existing `onVisibleRangeChange` callback.

**Tech Stack:** Node.js / Express / `node-fetch` / `lru-cache` / `p-limit` on backend. React + TypeScript + axios + Vite on frontend. No test framework in either repo — verification is curl + browser + type checks.

**Spec reference:** `docs/superpowers/specs/2026-05-21-news-carousel-top-comments-coverage-design.md`

---

## File Inventory

### Backend (`read-api`)

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add `p-limit@3.1.0` dependency (CommonJS-compatible) |
| `services/rssService.js` | Modify | Raise cap 7→25, add bounded concurrency, expose helper for new endpoint |
| `server.js` | Modify | Register `GET /api/trending/posts/:id/top-comments` route |

### Frontend (`reddzit`, at `../reddzit/` relative to read-api)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/helpers/DailyService.ts` | Modify | Add `getTopCommentsForPost(postId)` helper + export `INLINE_TOP_COMMENTS_CAP` constant |
| `src/components/NewsCarousel.tsx` | No change | Already reads `post.topComments` and emits `onVisibleRangeChange` |
| `src/components/TopFeed.tsx` | Modify | Wire lazy fetch + merge + prefetch window into the carousel |

---

## Task 1: Add `p-limit` dependency to `read-api`

**Files:**
- Modify: `read-api/package.json`

- [ ] **Step 1: Install `p-limit` at version 3.1.0**

The codebase uses CommonJS (`require()`). `p-limit` 4.x and 5.x are ESM-only. Pin to 3.x.

Run (from `read-api` directory):
```bash
npm install p-limit@3.1.0
```

Expected: `package.json` gains `"p-limit": "^3.1.0"` under dependencies. `package-lock.json` updates.

- [ ] **Step 2: Verify it loads under Node's CommonJS**

Run:
```bash
node -e "const pLimit = require('p-limit'); const l = pLimit(2); console.log(typeof l)"
```

Expected output: `function`

- [ ] **Step 3: Commit**

```bash
cd /Users/alexvallejo/Sites/personal/reddzit/read-api
git add package.json package-lock.json
git commit -m "Add p-limit dependency for bounded comment fan-out"
```

---

## Task 2: Raise inline cap to 25 and add bounded concurrency in `rssService`

**Files:**
- Modify: `read-api/services/rssService.js:289` (constant), `:293` (docblock), `:466-476` (fan-out)

- [ ] **Step 1: Add `p-limit` import and concurrency limiter at module scope**

In `services/rssService.js`, near the other `require()` calls at the top (after the `nodeFetch` require around line 29), add:

```js
const pLimit = require('p-limit');

// Bounded concurrency for the inline comment fan-out. With cap 25 the worst
// case is 25 simultaneous TCP connections to oauth.reddit.com without this.
const commentLimit = pLimit(10);
```

Place the `commentLimit` declaration above the `topCommentsCache` definition (around line 33) so it's near other shared module state.

- [ ] **Step 2: Raise the cap constant from 7 to 25**

Find:
```js
const TOP_COMMENT_TARGET_COUNT = 7;
```

Replace with:
```js
const TOP_COMMENT_TARGET_COUNT = 25;
```

- [ ] **Step 3: Update the stale "first 7 posts" docblock**

In the `getAggregatedFeed` docblock (around line 291–296), find:
```js
 * Extracts image URLs and (optionally) attaches top comments to the first 7 posts.
```

Replace with:
```js
 * Extracts image URLs and (optionally) attaches top comments to the first
 * TOP_COMMENT_TARGET_COUNT posts (25). Posts beyond this can be fetched on
 * demand via GET /api/trending/posts/:id/top-comments.
```

- [ ] **Step 4: Wrap the comment fan-out with `commentLimit`**

In `getAggregatedFeed`, find this block (around line 466-476):
```js
  if (withTopComments && posts.length > 0 && accessToken) {
    const targets = posts.slice(0, TOP_COMMENT_TARGET_COUNT);
    const commentResults = await Promise.allSettled(
      targets.map((post) => getTopComments(`t3_${post.id}`, { prisma, accessToken }))
    );
    commentResults.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value && r.value.length > 0) {
        targets[i].topComments = r.value;
      }
    });
  }
```

Replace with:
```js
  if (withTopComments && posts.length > 0 && accessToken) {
    const targets = posts.slice(0, TOP_COMMENT_TARGET_COUNT);
    const commentResults = await Promise.allSettled(
      targets.map((post) =>
        commentLimit(() => getTopComments(`t3_${post.id}`, { prisma, accessToken }))
      )
    );
    commentResults.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value && r.value.length > 0) {
        targets[i].topComments = r.value;
      }
    });
  }
```

- [ ] **Step 5: Start the dev server and verify the cap took effect**

From `read-api`:
```bash
npm run dev
```

In another shell, hit the endpoint and count posts with `topComments`:
```bash
curl -s 'http://localhost:3001/api/trending/rss?topic=news' | \
  node -e "const d=JSON.parse(require('fs').readFileSync(0)); \
    const withC=d.posts.filter(p=>p.topComments && p.topComments.length>0).length; \
    console.log('total=' + d.posts.length, 'withComments=' + withC, 'cached=' + d.cached);"
```

(Use the correct port — check `server.js` for `PORT`. Default appears to be 3001 but adjust if your local differs.)

Expected on a cold rebuild (`cached: false`):
- `total=50` (or close)
- `withComments` in the range 20–25 (some posts genuinely have no comments / are filtered)

If `cached: true`, hit it a second time after waiting 10 min, or clear the in-memory cache by restarting the dev server.

- [ ] **Step 6: Commit**

```bash
cd /Users/alexvallejo/Sites/personal/reddzit/read-api
git add services/rssService.js
git commit -m "Raise inline top-comments cap 7->25 with bounded concurrency

Comment fan-out now uses p-limit(10) to cap simultaneous TCP connections
to oauth.reddit.com. Worst-case cold rebuild burst is ~30 Reddit calls
which fits well under the 100/min OAuth ceiling even with multiple
cache keys expiring concurrently."
```

---

## Task 3: Add the lazy per-post top-comments endpoint

**Files:**
- Modify: `read-api/server.js` (add route near the existing `/api/trending/rss` registration around line 252)

- [ ] **Step 1: Verify `rssService.getTopComments` is already exported**

Run from `read-api`:
```bash
grep -n "getTopComments" services/rssService.js | grep -E "module.exports|exports\."
```

Expected: a line like `getTopComments,` inside the `module.exports = { ... }` block (around line 489). If missing, add it — but the existing code already exports it.

- [ ] **Step 2: Add the new route handler in `server.js`**

Find the registration of `/api/trending/rss` (around line 252) — the line `app.get('/api/trending/rss', async (req, res) => {`. Just BEFORE that line, add the constant and route below.

Also find where `getAppOnlyAccessToken` is already imported in `server.js`:
```bash
grep -n "getAppOnlyAccessToken" /Users/alexvallejo/Sites/personal/reddzit/read-api/server.js
```

If it's already imported (it should be, since `fetchRedditPublic` uses it for share previews), reuse it. If not, add `const { getAppOnlyAccessToken } = require('./controllers/redditProxyController');` near the other route-handler requires at the top.

Insert this code immediately above the existing `app.get('/api/trending/rss', ...)` route:

```js
// Lazy per-post top-comments endpoint. The trending feed hydrates the first
// TOP_COMMENT_TARGET_COUNT (25) posts inline; this endpoint serves the
// long-tail posts on demand from the client carousel.
const POST_ID_RE = /^[a-z0-9]{4,10}$/;

app.get('/api/trending/posts/:id/top-comments', async (req, res) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id.trim().toLowerCase() : '';
    if (!POST_ID_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid post id' });
    }

    let accessToken = null;
    try {
      accessToken = await getAppOnlyAccessToken();
    } catch (e) {
      console.warn('top-comments endpoint: could not get access token:', e.message);
    }

    const comments = await rssService.getTopComments(`t3_${id}`, { prisma, accessToken });
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ comments: comments || [] });
  } catch (error) {
    console.error('Top-comments endpoint error:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});
```

Note: this assumes `rssService` and `prisma` are already in scope at this point in `server.js` (they are — the existing `/api/trending/rss` route uses both).

- [ ] **Step 3: Restart the dev server (nodemon should pick it up automatically)**

If the dev server is still running from Task 2, nodemon will reload on save. Otherwise:
```bash
npm run dev
```

- [ ] **Step 4: Verify the endpoint with a valid id**

Pick a post id from the trending response (the `posts[0].id` value, which is the bare base-36 id without `t3_`):

```bash
# Get a real id from trending first
POST_ID=$(curl -s 'http://localhost:3001/api/trending/rss?topic=news' | \
  node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(d.posts[0].id);")
echo "Using post id: $POST_ID"

# Hit the new endpoint
curl -s "http://localhost:3001/api/trending/posts/$POST_ID/top-comments" | \
  node -e "const d=JSON.parse(require('fs').readFileSync(0)); \
    console.log('count=' + (d.comments || []).length); \
    if (d.comments && d.comments[0]) console.log('first author=' + d.comments[0].author);"
```

Expected: `count=` is some number 0-5 (the existing `TOP_COMMENTS_PER_POST` constant in rssService caps at 5), and a real author name appears.

- [ ] **Step 5: Verify validation rejects bad ids**

```bash
curl -s -o /dev/null -w "%{http_code}\n" 'http://localhost:3001/api/trending/posts/INVALID_ID_TOO_LONG_AND_UPPER/top-comments'
```

Expected: `400`

```bash
curl -s -o /dev/null -w "%{http_code}\n" 'http://localhost:3001/api/trending/posts/abc/top-comments'
```

Expected: `400` (too short — under 4 chars)

- [ ] **Step 6: Verify cache header**

```bash
curl -sI "http://localhost:3001/api/trending/posts/$POST_ID/top-comments" | grep -i cache-control
```

Expected: `Cache-Control: public, max-age=300`

- [ ] **Step 7: Commit**

```bash
cd /Users/alexvallejo/Sites/personal/reddzit/read-api
git add server.js
git commit -m "Add GET /api/trending/posts/:id/top-comments lazy endpoint

Serves top comments for a single post on demand, used by the news
carousel for slides past the inline cap. Reuses rssService.getTopComments
(1h LRU cache + circuit breaker), returns empty array on failure rather
than 5xx so the client can degrade silently."
```

---

## Task 4: Add `getTopCommentsForPost` helper to frontend `DailyService`

**Files:**
- Modify: `../reddzit/src/helpers/DailyService.ts`

> The frontend repo is at `/Users/alexvallejo/Sites/personal/reddzit/reddzit/` — the CLAUDE.md in `read-api` calls it `reddzit-refresh` but the actual directory name is `reddzit`. All frontend tasks operate inside that directory.

- [ ] **Step 1: Add the constant and helper to `DailyService.ts`**

Open `../reddzit/src/helpers/DailyService.ts`. The file currently exports `DailyService` as an object literal containing `getLatestReport`, `subscribe`, `trackEngagement`, `getTrendingRSS`, etc.

Near the top of the file with the other exported types (just after the `TrendingPost` interface around line 75), add:

```ts
// Mirrors the backend TOP_COMMENT_TARGET_COUNT in services/rssService.js.
// Posts at index < this number have topComments hydrated server-side;
// posts at index >= this number must be fetched via getTopCommentsForPost.
export const INLINE_TOP_COMMENTS_CAP = 25;
```

Then, inside the `DailyService` object, add a new method. Find the existing `getTrendingRSS` method (around line 145) and add this new method after it (before the closing `};` of the object):

```ts
  async getTopCommentsForPost(postId: string): Promise<TrendingPostTopComment[]> {
    if (!postId || !/^[a-z0-9]{4,10}$/.test(postId)) return [];
    try {
      const response = await axios.get<{ comments: TrendingPostTopComment[] }>(
        `${API_BASE_URL}/api/trending/posts/${encodeURIComponent(postId)}/top-comments`,
        { timeout: 8000 }
      );
      return response.data?.comments ?? [];
    } catch {
      return [];
    }
  },
```

The `TrendingPostTopComment` type is already exported from this file (line 44) so no new import is needed.

- [ ] **Step 2: Type-check the change**

From `/Users/alexvallejo/Sites/personal/reddzit/reddzit/`:
```bash
npx tsc --noEmit
```

Expected: no errors. If errors mention the new method, double-check the comma placement and method signature.

- [ ] **Step 3: Smoke-test the helper from a quick `tsx` script**

Quick sanity-check it returns shape-correct data. Create a throwaway file `/tmp/check-tc.mjs`:
```bash
cat > /tmp/check-tc.mjs <<'EOF'
import axios from 'axios';
const r = await axios.get('http://localhost:3001/api/trending/rss?topic=news');
const id = r.data.posts[0].id;
console.log('Trying id:', id);
const c = await axios.get(`http://localhost:3001/api/trending/posts/${id}/top-comments`);
console.log('comments count:', c.data.comments?.length);
console.log('first author:', c.data.comments?.[0]?.author);
EOF
cd /Users/alexvallejo/Sites/personal/reddzit/reddzit
node /tmp/check-tc.mjs
```

Expected: prints a post id, a comment count (0-5), and an author name. Confirms the endpoint round-trips and shapes match what TypeScript expects.

Delete the throwaway: `rm /tmp/check-tc.mjs`

- [ ] **Step 4: Commit**

```bash
cd /Users/alexvallejo/Sites/personal/reddzit/reddzit
git add src/helpers/DailyService.ts
git commit -m "Add DailyService.getTopCommentsForPost helper

Wraps GET /api/trending/posts/:id/top-comments. Returns [] on any
failure so the carousel can fall back gracefully. Also exports
INLINE_TOP_COMMENTS_CAP=25 so consumers know the slide-index boundary
where lazy fetching is needed."
```

---

## Task 5: Wire lazy fetch + prefetch into `TopFeed.tsx`

**Files:**
- Modify: `../reddzit/src/components/TopFeed.tsx` (rendering of `NewsCarousel` around line 387, plus add state + handler in the component body)

The carousel already emits `onVisibleRangeChange([prev, current, next])`. The current `TopFeed.tsx` does NOT pass this callback (verified). We will:
1. Maintain a `lazyComments` map of `postId -> TrendingPostTopComment[]`.
2. Track `inFlight` ids in a `useRef<Set<string>>` so refetches dedupe without rerendering.
3. When a visible-range event fires, compute the prefetch window `[currentIndex, currentIndex+1, currentIndex+2]` (we ignore the carousel's `prev` since we don't prefetch backwards).
4. For each target whose index is ≥ `INLINE_TOP_COMMENTS_CAP` and whose post has no `topComments` and isn't already fetched/in-flight, fire `DailyService.getTopCommentsForPost`.
5. Build a derived `postsWithComments` array (memoized) that overlays the lazy results onto the original posts. Pass that to the carousel.

- [ ] **Step 1: Update the import line**

In `src/components/TopFeed.tsx`, find:
```ts
import DailyService, { TrendingPost } from '../helpers/DailyService';
```

Replace with:
```ts
import DailyService, {
  INLINE_TOP_COMMENTS_CAP,
  TrendingPost,
  TrendingPostTopComment,
} from '../helpers/DailyService';
```

Also confirm `useMemo` is imported. The existing top line is:
```ts
import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
```

Change to:
```ts
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
```

- [ ] **Step 2: Add state + ref for lazy comments**

Inside the `TopFeed` component body, find the existing state declarations (around lines 74-80). After `const [viewMode, setViewMode] = useState<ViewMode>(() => loadViewMode());`, add:

```ts
  const [lazyComments, setLazyComments] = useState<Record<string, TrendingPostTopComment[]>>({});
  const lazyInFlight = useRef<Set<string>>(new Set());
```

- [ ] **Step 3: Reset lazy comments when posts change (new feed load)**

The lazy comments map is keyed by post id, so technically it doesn't need to clear when posts change. But to prevent unbounded growth across feed switches, clear it when the feed identity changes. Add a `useEffect` near the existing `useEffect`s that watch `dataSubreddit` / `dataTopic`:

After the existing `useEffect(() => { loadTopPosts(); }, [loadTopPosts]);` (around line 159-161), add:

```ts
  useEffect(() => {
    setLazyComments({});
    lazyInFlight.current = new Set();
  }, [dataSubreddit, dataTopic]);
```

- [ ] **Step 4: Add the visible-range handler that triggers prefetch**

Find the line `const visiblePosts = posts.filter(post => !skippedPostIds.has(post.id));` (line 251). After it, add:

```ts
  const handleVisibleRange = useCallback((indices: number[]) => {
    if (indices.length === 0) return;
    // NewsCarousel calls onVisibleRangeChange with `Array.from(new Set([prev, current, next]))`.
    // JS Set iteration order is insertion order, so element [1] is `current` when there are 3
    // unique indices. With wrap-around (e.g. on the last slide [49, 0, 1]), [1] is still `current`.
    // When total<=2 the array may have 1-2 elements; use [0] as a safe fallback.
    const current = indices.length >= 2 ? indices[1] : indices[0];

    const targets: number[] = [];
    for (let offset = 0; offset <= 2; offset++) {
      const idx = current + offset;
      if (idx < visiblePosts.length) targets.push(idx);
    }

    for (const idx of targets) {
      if (idx < INLINE_TOP_COMMENTS_CAP) continue;
      const post = visiblePosts[idx];
      if (!post) continue;
      if (post.topComments && post.topComments.length > 0) continue;
      if (lazyComments[post.id]) continue;
      if (lazyInFlight.current.has(post.id)) continue;

      lazyInFlight.current.add(post.id);
      DailyService.getTopCommentsForPost(post.id)
        .then((comments) => {
          if (comments && comments.length > 0) {
            setLazyComments((prev) => ({ ...prev, [post.id]: comments }));
          }
        })
        .finally(() => {
          lazyInFlight.current.delete(post.id);
        });
    }
  }, [visiblePosts, lazyComments]);
```

> **Why `indices[1]` is `current`:** look at `NewsCarousel.tsx:72-75` — it builds the array as `Array.from(new Set([prev, current, next]))`. JS Set iteration is insertion order, so index 1 is `current` whenever the set has ≥ 2 distinct values. This is brittle in the sense that it depends on carousel internals; if you want to harden it later, add a second-arg `currentIndex` to the callback signature. Out of scope for this iteration.

- [ ] **Step 5: Build `postsWithComments` overlay and pass to the carousel**

Right below `handleVisibleRange`, add a memoized overlay:

```ts
  const postsWithComments = useMemo(() => {
    if (Object.keys(lazyComments).length === 0) return visiblePosts;
    return visiblePosts.map((p) => {
      if (p.topComments && p.topComments.length > 0) return p;
      const lazy = lazyComments[p.id];
      return lazy ? { ...p, topComments: lazy } : p;
    });
  }, [visiblePosts, lazyComments]);
```

Then update the `NewsCarousel` JSX (around line 387) from:
```tsx
          <NewsCarousel
            posts={visiblePosts}
            onPostClick={handlePostClick}
            onSkipPost={handleSkipPost}
          />
```

To:
```tsx
          <NewsCarousel
            posts={postsWithComments}
            onPostClick={handlePostClick}
            onSkipPost={handleSkipPost}
            onVisibleRangeChange={handleVisibleRange}
          />
```

(Leave the `MagazineGrid` usage above untouched — grid mode doesn't need lazy comments.)

- [ ] **Step 6: Type-check**

From `/Users/alexvallejo/Sites/personal/reddzit/reddzit/`:
```bash
npx tsc --noEmit
```

Expected: no errors. If there are errors about `TrendingPostTopComment` not exported or `INLINE_TOP_COMMENTS_CAP` not found, double-check Task 4's edits to `DailyService.ts`.

- [ ] **Step 7: Lint**

```bash
npm run lint
```

Expected: clean (or no new warnings vs. baseline).

- [ ] **Step 8: Manual browser verification**

Make sure both dev servers are running:
- `read-api`: `npm run dev` (port 3001 typically)
- `reddzit` frontend: `npm run dev` (Vite default 5173)

Open the browser at the frontend dev URL, navigate to `/news`. Open browser DevTools → Network tab → filter for `top-comments`.

Verify:
1. On initial page load: zero requests to `/api/trending/posts/.../top-comments` (slides 0-24 use inline).
2. Swipe / arrow-key past slide 24: requests to `/api/trending/posts/:id/top-comments` start firing.
3. On slide 24, requests fire for posts at indices 25 and 26 (prefetch). On slide 25, requests fire for 26 and 27 (already-cached entries don't refetch).
4. The "Top comments" panel on the right side of the carousel populates for slides 25+ within at most one swipe.
5. No console errors.

- [ ] **Step 9: Commit**

```bash
cd /Users/alexvallejo/Sites/personal/reddzit/reddzit
git add src/components/TopFeed.tsx
git commit -m "Lazy-fetch top comments for news carousel slides 25+

Maintains a lazyComments map and an inFlight Set, listens to
NewsCarousel's existing onVisibleRangeChange callback, and prefetches
the current + next 2 slides past the inline-cap boundary. Overlays
fetched comments onto the post objects before passing them into the
carousel so the existing render path is unchanged."
```

---

## Task 6: End-to-end smoke check

**Files:** none modified — verification only.

- [ ] **Step 1: Re-verify backend inline cap end-to-end**

With `read-api` dev server running and after a fresh restart (to clear in-memory cache):

```bash
curl -s 'http://localhost:3001/api/trending/rss?topic=news' | \
  node -e "
    const d = JSON.parse(require('fs').readFileSync(0));
    const total = d.posts.length;
    const withC = d.posts.filter(p => p.topComments && p.topComments.length > 0).length;
    const first25WithC = d.posts.slice(0, 25).filter(p => p.topComments && p.topComments.length >= 3).length;
    console.log('total=' + total);
    console.log('withComments=' + withC);
    console.log('first25 with >=3 comments=' + first25WithC + '/25');
    console.log('cached=' + d.cached);
  "
```

Expected (acceptance criterion from spec):
- `total` near 50
- `first25 with >=3 comments` >= 20 (80%)

If the threshold isn't met, repeat once after waiting — Reddit's `/comments` endpoint occasionally returns 5xx and gets cached as null for 5 min. If it's still under 20/25 after a clean retry, investigate whether the circuit breaker is tripped: `curl -s http://localhost:3001/api/status/reddit`.

- [ ] **Step 2: Re-verify lazy endpoint**

```bash
POST_ID=$(curl -s 'http://localhost:3001/api/trending/rss?topic=news' | \
  node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(d.posts[30].id);")
echo "Lazy-fetching for post 30 (id=$POST_ID)"
curl -s "http://localhost:3001/api/trending/posts/$POST_ID/top-comments" | \
  node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log('comments=' + (d.comments||[]).length);"
```

Expected: a comment count 0-5 with no errors.

- [ ] **Step 3: Frontend visual check across slides 0-49**

From the carousel page in the browser:
1. Slide 0-24: comments panel populated immediately, no network requests for `top-comments`.
2. Slide 25-49: when arriving at each slide, comments panel populated within ≤ 1 swipe latency (typically zero because of prefetch).
3. Edge case: skip a few posts using the skip button. Visible range should still drive prefetches for the new ordering. Verify by skipping post 10 and confirming slide 24 still gets prefetch for slides 25/26 (which are now the originally-26th and originally-27th posts in the filtered list).

- [ ] **Step 4: No commit** — this task is verification only.

---

## Task 7: Update CLAUDE.md to reflect the new endpoint and architecture

**Files:**
- Modify: `read-api/CLAUDE.md` (extend the "Cron Jobs" / API section with a note about the new endpoint and updated inline cap)

- [ ] **Step 1: Add a short subsection to CLAUDE.md**

Open `read-api/CLAUDE.md`. Find the "Share Preview Caching Architecture" section. After that section's "Why not Redis?" subsection, BEFORE the "Cron Jobs" heading, insert a new section:

```markdown
## Top Comments Hydration (Trending Feed)

`/api/trending/rss` hydrates the first **25** posts with up to 5 top comments each (constant `TOP_COMMENT_TARGET_COUNT` in `services/rssService.js`). Fan-out is gated by `p-limit(10)` to bound simultaneous TCP connections to `oauth.reddit.com`.

Posts beyond index 24 are served on demand via:

`GET /api/trending/posts/:id/top-comments` → `{ comments: TrendingPostTopComment[] }`

This endpoint:
- Validates `:id` against `/^[a-z0-9]{4,10}$/` (Reddit base-36 post id shape)
- Reuses the same 1-hour per-post LRU cache (`topCommentsCache` in `rssService.js`)
- Honors the `redditService.isApiRestricted` circuit breaker — returns `{ comments: [] }` on 5xx / rate limit, never propagates errors to the client
- Sets `Cache-Control: public, max-age=300`

The frontend (`reddzit/src/components/TopFeed.tsx`) lazy-fetches via this endpoint for slides ≥ 25 with a `current+2` prefetch window driven by the carousel's `onVisibleRangeChange` callback.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/alexvallejo/Sites/personal/reddzit/read-api
git add CLAUDE.md
git commit -m "Document top-comments hydration and lazy endpoint in CLAUDE.md"
```

---

## Post-Deploy Verification

After both repos are deployed:

- [ ] Hit `https://read-api.reddzit.com/api/trending/rss?topic=news` from a clean machine (no cache). Confirm 80%+ of the first 25 posts have ≥ 3 comments.
- [ ] Hit `https://read-api.reddzit.com/api/trending/posts/<some-recent-id>/top-comments`. Confirm 200 with `{ comments: [...] }`.
- [ ] In production browser, navigate to `/news`, swipe past slide 25 a few times, confirm comments appear with no perceptible delay.
- [ ] One week later: check `apiStatus` table for any sustained 429-induced restrictions tied to the rollout. If found, consider lowering `TOP_COMMENT_TARGET_COUNT` to 20 or tightening `pLimit` to 6.

## Rollback

Each change is independently revertible:

- Inline cap regression: revert the `services/rssService.js` commit; ship a hotfix returning the constant to `7`.
- Lazy endpoint problems: revert the `server.js` route; the frontend's `getTopCommentsForPost` will start returning `[]` (via its catch) for everything past slide 24, restoring pre-change behavior for that range.
- Frontend bug: revert the `TopFeed.tsx` commit; lazy fetching stops entirely. The backend cap of 25 still benefits all users.
