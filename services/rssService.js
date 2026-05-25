const Parser = require('rss-parser');

const USER_AGENT = process.env.USER_AGENT || 'Reddzit/1.0';

const parser = new Parser({
  customFields: {
    item: [
      ['media:thumbnail', 'thumbnail'],
    ]
  },
  headers: {
    'User-Agent': USER_AGENT
  }
});

// Simple in-memory cache
let cache = {
  data: null,
  timestamp: 0
};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Per-key cache for JSON-endpoint aggregations
const JSON_CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const jsonCache = new Map(); // key -> { data, timestamp }

const { LRUCache } = require('lru-cache');
const redditService = require('./redditService');
const nodeFetch = require('node-fetch');
const pLimit = require('p-limit');

// Bounded concurrency for the inline comment fan-out. With cap 25 the worst
// case is 25 simultaneous TCP connections to oauth.reddit.com without this.
const commentLimit = pLimit(10);

// Cache top comments per post fullname. Top comments on hero posts don't
// change much in an hour, and the same post is likely visible to many users.
const topCommentsCache = new LRUCache({
  max: 2000,
  ttl: 1000 * 60 * 60, // 1 hour
});

// Cache by_id enrichment results per fullname. The listing endpoints
// strip preview data on some subreddits (notably r/news), so we batch-fetch
// the missing posts via /by_id where preview data IS returned. Cached
// aggressively since post metadata is effectively immutable.
const enrichmentCache = new LRUCache({
  max: 2000,
  ttl: 1000 * 60 * 60, // 1 hour
});

/**
 * Fetch trending posts from Reddit RSS feed
 * No OAuth required, no rate limits
 */
async function getTrendingFromRSS(subreddit = 'all', limit = 15) {
  // Skip r/all - Reddit blocks RSS from cloud IPs (403)
  if (subreddit === 'all') {
    return [];
  }

  const now = Date.now();
  const cacheKey = `${subreddit}-${limit}`;

  // Return cached data if fresh
  if (cache.data && cache.key === cacheKey && (now - cache.timestamp) < CACHE_DURATION) {
    return cache.data;
  }

  try {
    const feed = await parser.parseURL(`https://www.reddit.com/r/${subreddit}.rss`);

    const posts = feed.items.slice(0, limit).map((item, index) => {
      // Extract subreddit from categories or link
      let postSubreddit = subreddit;
      if (item.categories && item.categories.length > 0) {
        // Reddit RSS puts subreddit in categories
        const subCat = item.categories.find(c => c.startsWith('/r/'));
        if (subCat) {
          postSubreddit = subCat.replace('/r/', '');
        }
      }

      // Try to extract subreddit from link if not found
      if (postSubreddit === 'all' && item.link) {
        const match = item.link.match(/\/r\/([^/]+)\//);
        if (match) {
          postSubreddit = match[1];
        }
      }

      return {
        id: item.id || item.guid || `rss-${index}`,
        title: item.title,
        subreddit: postSubreddit,
        link: item.link,
        author: item.author || item.creator,
        pubDate: item.pubDate || item.isoDate,
      };
    });

    // Update cache
    cache = {
      data: posts,
      key: cacheKey,
      timestamp: now
    };

    return posts;
  } catch (error) {
    console.error(`RSS fetch error for r/${subreddit}:`, error.message);
    // Return stale cache on error if available
    if (cache.data) {
      return cache.data;
    }
    throw error;
  }
}

/**
 * Fetch top posts from Reddit's public JSON endpoint
 * No OAuth required, provides full post data (score, comments, thumbnails)
 * Rate limited but much more generous than OAuth endpoints
 */
async function getTopPostsFromJSON(subreddit = 'all', limit = 25, sort = 'hot') {
  const now = Date.now();
  const cacheKey = `${subreddit}-${limit}-${sort}`;

  // Return cached data if fresh
  const cached = jsonCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < JSON_CACHE_DURATION) {
    console.log('Returning cached JSON data');
    return cached.data;
  }

  try {
    const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}`;
    console.log(`Fetching from: ${url}`);

    const response = await nodeFetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
      }
    });

    if (!response.ok) {
      throw new Error(`Reddit JSON API returned ${response.status}`);
    }

    const data = await response.json();
    const posts = data.data.children
      .filter(child => child.kind === 't3') // Only link posts
      .map(child => child.data)
      .filter(post => !post.over_18); // Filter NSFW

    // Update cache
    jsonCache.set(cacheKey, { data: posts, timestamp: now });

    return posts;
  } catch (error) {
    console.error('JSON fetch error:', error.message);
    // Return stale cache on error if available
    const stale = jsonCache.get(cacheKey);
    if (stale) {
      return stale.data;
    }
    throw error;
  }
}

const TOP_COMMENTS_PER_POST = 5;
const TOP_COMMENTS_FETCH_LIMIT = 15;

/**
 * Fetch the top comments for a Reddit post (by fullname like "t3_abc123").
 * Returns an array of { id, body, author, score, permalink } with full body,
 * or null when no comments / Reddit unavailable.
 *
 * Cached aggressively (LRU, 1h) since top comments on popular posts are stable.
 * Honors the circuit breaker via redditService.isApiRestricted — returns null
 * (not throws) when Reddit is rate-limiting us, so the caller can degrade.
 */
async function getTopComments(fullname, { prisma, accessToken } = {}) {
  if (!fullname || !fullname.startsWith('t3_')) return null;

  const cached = topCommentsCache.get(fullname);
  if (cached !== undefined) return cached;

  if (prisma) {
    const restricted = await redditService.isApiRestricted(prisma);
    if (restricted) {
      topCommentsCache.set(fullname, null, { ttl: 1000 * 60 * 5 });
      return null;
    }
  }

  if (!accessToken) {
    return null;
  }

  const id = fullname.replace(/^t3_/, '');
  const url = `https://oauth.reddit.com/comments/${encodeURIComponent(id)}.json?limit=${TOP_COMMENTS_FETCH_LIMIT}&depth=1&sort=top`;
  let result = null;
  try {
    const response = await nodeFetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': process.env.USER_AGENT || 'Reddzit/1.0',
      },
    });
    if (!response.ok) {
      console.warn(`getTopComments: ${fullname} returned ${response.status}`);
      topCommentsCache.set(fullname, null, { ttl: 1000 * 60 * 5 });
      return null;
    }
    const json = await response.json();
    // Reddit returns [postListing, commentListing] for /comments/<id>.json.
    // Anything else (e.g. {message: "Quota exceeded"} on a soft rate-limit) means
    // we got a 200 but no usable data. Cache briefly so we retry, instead of
    // letting the default 1h TTL pin null on a perfectly good post.
    if (!Array.isArray(json) || !json[1] || !json[1].data) {
      console.warn(`getTopComments: ${fullname} returned unexpected payload shape`);
      topCommentsCache.set(fullname, null, { ttl: 1000 * 60 * 5 });
      return null;
    }
    const children = json[1].data.children || [];
    const comments = [];
    for (const child of children) {
      if (!child || child.kind !== 't1' || !child.data) continue;
      const data = child.data;
      if (typeof data.body !== 'string' || data.body.length === 0) continue;
      if (data.body === '[removed]') continue;
      // Skip moderator-distinguished and stickied comments — these are typically
      // AutoModerator / subreddit bot announcements (e.g. PoliticsModeratorBot)
      // that Reddit pins above actual top comments under sort=top.
      if (data.distinguished === 'moderator' || data.distinguished === 'admin') continue;
      if (data.stickied === true) continue;
      comments.push({
        id: data.id,
        body: data.body,
        author: data.author || '[deleted]',
        score: typeof data.score === 'number' ? data.score : 0,
        permalink: data.permalink || null,
      });
      if (comments.length >= TOP_COMMENTS_PER_POST) break;
    }
    result = comments.length > 0 ? comments : null;
  } catch (error) {
    console.warn(`getTopComments error for ${fullname}:`, error.message);
    topCommentsCache.set(fullname, null, { ttl: 1000 * 60 * 5 });
    return null;
  }

  topCommentsCache.set(fullname, result);
  return result;
}

const { pickPreviewImageOrNull } = require('./redditMediaService');
const { getAppOnlyAccessToken } = require('../controllers/redditProxyController');

// OAuth-authenticated endpoint — Reddit blocks unauthenticated www.reddit.com
// requests from cloud IPs (403). Listings, enrichment, and comments all use OAuth.
const FEED_URL_BASE = 'https://oauth.reddit.com';

const ALLOWED_SORTS = new Set(['best', 'hot', 'new', 'top', 'rising', 'controversial']);
const SORTS_WITH_TIME_RANGE = new Set(['top', 'controversial']);

const TOPIC_SUBS = {
  news: ['news', 'worldnews', 'politics', 'upliftingnews', 'nottheonion'],
  'less-political': ['news', 'worldnews', 'upliftingnews', 'nottheonion', 'science'],
};
const ALLOWED_TOPICS = new Set(Object.keys(TOPIC_SUBS));

/**
 * Build the list of feed URLs to aggregate based on the requested view.
 *
 * - topic provided  => plus-syntax fetch across the topic's curated sub list
 * - sort provided   => single-sort fetch from r/<subreddit> (or r/all)
 * - neither, no sub => "/top" view: r/all + r/popular mix
 * - neither, sub    => three sorts of that single sub
 */
function buildFeedUrls(subreddit, sort, topic) {
  if (topic && TOPIC_SUBS[topic]) {
    const subs = TOPIC_SUBS[topic].join('+');
    const sortPath = sort || 'hot';
    const timeRange = SORTS_WITH_TIME_RANGE.has(sortPath) ? '&t=day' : '';
    return [`${FEED_URL_BASE}/r/${subs}/${sortPath}.json?limit=50${timeRange}`];
  }
  if (sort) {
    const sub = subreddit || 'all';
    const timeRange = SORTS_WITH_TIME_RANGE.has(sort) ? '&t=day' : '';
    return [`${FEED_URL_BASE}/r/${sub}/${sort}.json?limit=50${timeRange}`];
  }
  if (!subreddit) {
    return [
      `${FEED_URL_BASE}/r/all/hot.json?limit=50`,
      `${FEED_URL_BASE}/r/all/rising.json?limit=25`,
      `${FEED_URL_BASE}/r/all/top.json?t=day&limit=25`,
      `${FEED_URL_BASE}/r/popular/hot.json?limit=25`,
      `${FEED_URL_BASE}/r/popular/top.json?t=day&limit=25`,
    ];
  }
  return [
    `${FEED_URL_BASE}/r/${subreddit}/hot.json?limit=50`,
    `${FEED_URL_BASE}/r/${subreddit}/rising.json?limit=25`,
    `${FEED_URL_BASE}/r/${subreddit}/top.json?t=day&limit=25`,
  ];
}

const TOP_COMMENT_TARGET_COUNT = 25;

/**
 * Aggregate multiple Reddit JSON sorts into a deduped feed of posts.
 * Extracts image URLs and (optionally) attaches top comments to the first
 * TOP_COMMENT_TARGET_COUNT posts (25). Posts beyond this can be fetched on
 * demand via GET /api/trending/posts/:id/top-comments.
 *
 * Returns: { posts: FeedPost[], generatedAt: string, cached: boolean }
 */
async function getAggregatedFeed({ subreddit, sort, topic, withTopComments = true, prisma = null } = {}) {
  const normalizedSub = subreddit ? subreddit.trim().toLowerCase() : null;
  const rawSort = typeof sort === 'string' ? sort.trim().toLowerCase() : null;
  const normalizedSort = rawSort && ALLOWED_SORTS.has(rawSort) ? rawSort : null;
  const rawTopic = typeof topic === 'string' ? topic.trim().toLowerCase() : null;
  const normalizedTopic = rawTopic && ALLOWED_TOPICS.has(rawTopic) ? rawTopic : null;
  const subKey = normalizedTopic ? `topic-${normalizedTopic}` : (normalizedSub || 'top');
  const cacheKey = `agg:${subKey}:${normalizedSort || 'mix'}:${withTopComments ? 'tc2' : 'tc0'}`;

  const now = Date.now();
  const cached = jsonCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < JSON_CACHE_DURATION) {
    return { ...cached.data, cached: true };
  }

  // OAuth token shared across listing fetches, by_id enrichment, and top-comment
  // fetches. Required for listings to work in production (Reddit blocks cloud IPs
  // from unauthenticated www.reddit.com endpoints with 403).
  let accessToken = null;
  try {
    accessToken = await getAppOnlyAccessToken();
  } catch (e) {
    console.warn('getAggregatedFeed: could not get access token:', e.message);
  }

  const urls = buildFeedUrls(normalizedSub, normalizedSort, normalizedTopic);
  const userAgent = process.env.USER_AGENT || 'Reddzit/1.0';

  const parsedResults = await Promise.allSettled(
    urls.map(async (url) => {
      const response = await nodeFetch(url, {
        headers: {
          'User-Agent': userAgent,
          ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
        },
      });
      if (!response.ok) return [];
      const json = await response.json();
      return (json && json.data && json.data.children) || [];
    })
  );

  const allChildren = [];
  for (const result of parsedResults) {
    if (result.status === 'fulfilled') {
      allChildren.push(...result.value);
    } else {
      console.warn('getAggregatedFeed: a feed fetch/parse failed:', result.reason?.message || result.reason);
    }
  }

  if (allChildren.length === 0) {
    // If we have a stale cache, return it; otherwise throw so the route returns 500
    if (cached) return { ...cached.data, cached: true };
    throw new Error('No posts from any feed');
  }

  const seen = new Set();
  const posts = [];
  for (const child of allChildren) {
    if (!child || child.kind !== 't3') continue;
    const data = child.data;
    if (!data || data.over_18 || seen.has(data.id)) continue;
    seen.add(data.id);

    const isSelfPost = !!data.is_self;
    const selftextRaw = isSelfPost && typeof data.selftext === 'string' ? data.selftext : '';
    const selftext = selftextRaw.length > 140 ? selftextRaw.slice(0, 137) + '...' : selftextRaw;

    posts.push({
      id: data.id,
      title: data.title,
      subreddit: data.subreddit,
      link: `https://www.reddit.com${data.permalink}`,
      author: data.author,
      pubDate: new Date(data.created_utc * 1000).toISOString(),
      imageUrl: pickPreviewImageOrNull(data),
      selftext: selftext || undefined,
      score: typeof data.score === 'number' ? data.score : undefined,
      numComments: typeof data.num_comments === 'number' ? data.num_comments : undefined,
      postHint: data.post_hint || undefined,
    });
  }

  // ENRICHMENT — some subreddits (notably r/news) strip preview data from
  // listing endpoints. For posts missing imageUrl, batch-fetch via by_id
  // where preview data is returned. One OAuth call regardless of count.
  // (accessToken was fetched above, shared across listings/enrichment/comments.)
  const needEnrichment = posts.filter((p) => !p.imageUrl);

  if (needEnrichment.length > 0) {
    const fromCache = [];
    const toFetch = [];
    for (const post of needEnrichment) {
      const fullname = `t3_${post.id}`;
      const cachedEnrichment = enrichmentCache.get(fullname);
      if (cachedEnrichment !== undefined) {
        fromCache.push({ post, enrichment: cachedEnrichment });
      } else {
        toFetch.push(post);
      }
    }
    // Apply cached enrichments first
    for (const { post, enrichment } of fromCache) {
      if (enrichment) {
        if (enrichment.imageUrl) post.imageUrl = enrichment.imageUrl;
        if (enrichment.postHint) post.postHint = enrichment.postHint;
      }
    }
    // Batch-fetch any uncached candidates
    if (toFetch.length > 0 && accessToken) {
      // Reddit accepts up to 100 fullnames per /by_id request
      const CHUNK_SIZE = 100;
      for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
        const chunk = toFetch.slice(i, i + CHUNK_SIZE);
        const fullnames = chunk.map((p) => `t3_${p.id}`).join(',');
        const url = `https://oauth.reddit.com/by_id/${fullnames}?raw_json=1`;
        try {
          const response = await nodeFetch(url, {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'User-Agent': userAgent,
            },
          });
          if (!response.ok) {
            console.warn(`getAggregatedFeed: by_id enrichment returned ${response.status}, leaving ${chunk.length} posts un-enriched`);
            // Cache the misses so we don't retry storms — short TTL since this
            // could be transient (rate limit, etc.)
            for (const post of chunk) {
              enrichmentCache.set(`t3_${post.id}`, null, { ttl: 1000 * 60 * 5 });
            }
            continue;
          }
          const json = await response.json();
          const children = (json && json.data && json.data.children) || [];
          // Index returned children by id for quick lookup
          const byId = new Map();
          for (const child of children) {
            if (child && child.kind === 't3' && child.data) {
              byId.set(child.data.id, child.data);
            }
          }
          // Apply enrichment to each post in the chunk
          for (const post of chunk) {
            const data = byId.get(post.id);
            const enrichment = data
              ? {
                  imageUrl: pickPreviewImageOrNull(data),
                  postHint: data.post_hint || null,
                }
              : null;
            // Success path: cache with default 1h TTL (failures use 5min above to allow faster retry on transient errors)
            enrichmentCache.set(`t3_${post.id}`, enrichment);
            if (enrichment) {
              if (enrichment.imageUrl) post.imageUrl = enrichment.imageUrl;
              if (enrichment.postHint) post.postHint = enrichment.postHint;
            }
          }
        } catch (error) {
          console.warn('getAggregatedFeed: enrichment fetch threw:', error.message);
          // Cache the misses briefly to avoid retry storms
          for (const post of chunk) {
            enrichmentCache.set(`t3_${post.id}`, null, { ttl: 1000 * 60 * 5 });
          }
        }
      }
    }
  }

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

  const payload = {
    posts,
    generatedAt: new Date().toISOString(),
  };
  jsonCache.set(cacheKey, { data: payload, timestamp: now });
  return { ...payload, cached: false };
}

module.exports = {
  getTrendingFromRSS,
  getTopPostsFromJSON,
  getTopComments,
  getAggregatedFeed,
  topCommentsCache, // exported for testing/inspection only
  enrichmentCache, // exported for testing/inspection only
};
