const Parser = require('rss-parser');

const parser = new Parser({
  customFields: {
    item: [
      ['media:thumbnail', 'thumbnail'],
    ]
  }
});

// Simple in-memory cache
let cache = {
  data: null,
  timestamp: 0
};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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

module.exports = {
  getTrendingFromRSS
};
