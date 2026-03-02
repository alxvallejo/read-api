const nodeFetch = require('node-fetch');

const NEWS_API_BASE = 'https://newsapi.org/v2';
const USER_AGENT = process.env.USER_AGENT || 'Reddzit/1.0';

// Map our internal category slugs to NewsAPI categories
// https://newsapi.org/docs/endpoints/top-headlines
const CATEGORY_MAP = {
  tech: 'technology',
  science: 'science',
  finance: 'business',
  gaming: 'entertainment',
  entertainment: 'entertainment',
  news: 'general',
  selfimprovement: 'health',
};

// In-memory cache per category
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch top headlines from NewsAPI for a given category slug.
 * @param {string} categorySlug - Internal category slug (e.g. 'tech', 'science')
 * @param {number} limit - Max articles to return
 * @returns {Array<{ title, description, source, url, imageUrl, publishedAt }>}
 */
async function getHeadlines(categorySlug = 'general', limit = 10) {
  if (!process.env.NEWS_API_KEY) {
    console.log('NEWS_API_KEY not set, skipping external news fetch');
    return [];
  }

  const newsCategory = CATEGORY_MAP[categorySlug] || 'general';
  const cacheKey = `${newsCategory}-${limit}`;
  const now = Date.now();

  // Return cached data if fresh
  const cached = cache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  try {
    const url = `${NEWS_API_BASE}/top-headlines?country=us&category=${newsCategory}&pageSize=${limit}`;
    const response = await nodeFetch(url, {
      headers: {
        'X-Api-Key': process.env.NEWS_API_KEY,
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`NewsAPI returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.status !== 'ok' || !Array.isArray(data.articles)) {
      throw new Error(`NewsAPI error: ${data.message || 'Unknown error'}`);
    }

    const articles = data.articles
      .filter(a => a.title && a.title !== '[Removed]')
      .map(a => ({
        title: a.title,
        description: a.description || '',
        source: a.source?.name || 'Unknown',
        url: a.url,
        imageUrl: a.urlToImage || null,
        publishedAt: a.publishedAt,
        _origin: 'newsapi',
      }));

    cache.set(cacheKey, { data: articles, timestamp: now });
    return articles;
  } catch (error) {
    console.error(`NewsAPI fetch error (${newsCategory}):`, error.message);
    // Return stale cache on error
    const stale = cache.get(cacheKey);
    if (stale) return stale.data;
    return [];
  }
}

/**
 * Fetch headlines across multiple category slugs and merge results.
 * Deduplicates by URL.
 * @param {string[]} categorySlugs - Array of internal category slugs
 * @param {number} perCategory - Articles per category
 * @returns {Array}
 */
async function getHeadlinesMultiCategory(categorySlugs = ['tech', 'science', 'news'], perCategory = 5) {
  const allArticles = [];
  const seenUrls = new Set();

  for (const slug of categorySlugs) {
    const articles = await getHeadlines(slug, perCategory);
    for (const article of articles) {
      if (!seenUrls.has(article.url)) {
        seenUrls.add(article.url);
        allArticles.push({ ...article, _category: slug });
      }
    }
  }

  return allArticles;
}

/**
 * Fuzzy title similarity check for deduplication across sources.
 * Returns true if titles are likely about the same story.
 */
function titlesMatch(titleA, titleB) {
  const normalize = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const a = normalize(titleA);
  const b = normalize(titleB);

  if (a === b) return true;

  // Token overlap check
  const tokensA = new Set(a.split(' ').filter(w => w.length > 3));
  const tokensB = new Set(b.split(' ').filter(w => w.length > 3));
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return (overlap / union) >= 0.5;
}

module.exports = {
  getHeadlines,
  getHeadlinesMultiCategory,
  titlesMatch,
  CATEGORY_MAP,
};
