const Parser = require('rss-parser');

const parser = new Parser({
  customFields: {
    item: [
      ['media:thumbnail', 'thumbnail'],
    ]
  }
});

const USER_AGENT = process.env.USER_AGENT || 'Reddzit/1.0';

// Simple in-memory cache
let cache = {
  data: null,
  timestamp: 0
};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Separate cache for JSON endpoint
let jsonCache = {
  data: null,
  timestamp: 0,
  key: null
};
const JSON_CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch trending posts from Reddit RSS feed
 * No OAuth required, no rate limits
 */
async function getTrendingFromRSS(subreddit = 'all', limit = 15) {
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
    console.error('RSS fetch error:', error.message);
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
  if (jsonCache.data && jsonCache.key === cacheKey && (now - jsonCache.timestamp) < JSON_CACHE_DURATION) {
    console.log('Returning cached JSON data');
    return jsonCache.data;
  }

  try {
    const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}`;
    console.log(`Fetching from: ${url}`);

    const response = await fetch(url, {
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
    jsonCache = {
      data: posts,
      key: cacheKey,
      timestamp: now
    };

    return posts;
  } catch (error) {
    console.error('JSON fetch error:', error.message);
    // Return stale cache on error if available
    if (jsonCache.data && jsonCache.key === cacheKey) {
      return jsonCache.data;
    }
    throw error;
  }
}

module.exports = {
  getTrendingFromRSS,
  getTopPostsFromJSON
};
