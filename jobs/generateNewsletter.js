require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const newsService = require('../services/newsService');
const rssService = require('../services/rssService');
const llmService = require('../services/llmService');
const readController = require('../controllers/readController');
const emailService = require('../services/emailService');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Categories to pull news for
const NEWS_CATEGORIES = ['tech', 'science', 'news', 'finance'];
const ARTICLES_PER_CATEGORY = 5;
const REDDIT_POST_COUNT = 10;
const MAX_NEWSLETTER_STORIES = 15;

/**
 * Generate and send the daily newsletter.
 * Combines external news (NewsAPI) with trending Reddit posts,
 * runs a single batched LLM call for all summaries, stores to DB,
 * and sends to subscribers.
 */
async function generateNewsletter(force = false) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  console.log(`Starting Newsletter Generation for ${today.toISOString()}`);

  // 1. Check if already generated today
  const existing = await prisma.newsletterIssue.findUnique({
    where: { issueDate: today },
  });

  if (existing && existing.status === 'PUBLISHED' && !force) {
    console.log('Newsletter already published today. Use --force to regenerate.');
    await cleanup();
    return;
  }

  // 2. Fetch external news articles
  console.log('Fetching external news...');
  const newsArticles = await newsService.getHeadlinesMultiCategory(
    NEWS_CATEGORIES,
    ARTICLES_PER_CATEGORY
  );
  console.log(`Fetched ${newsArticles.length} external articles`);

  // 3. Fetch trending Reddit posts (no OAuth needed)
  console.log('Fetching Reddit trending posts...');
  let redditPosts = [];
  try {
    const rawPosts = await rssService.getTopPostsFromJSON('all', REDDIT_POST_COUNT, 'hot');
    redditPosts = rawPosts.map(p => ({
      title: p.title,
      description: p.selftext ? p.selftext.slice(0, 300) : '',
      source: `r/${p.subreddit}`,
      url: p.url && !p.url.includes('reddit.com') ? p.url : null,
      imageUrl: p.thumbnail && p.thumbnail.startsWith('http') ? p.thumbnail : null,
      publishedAt: new Date(p.created_utc * 1000).toISOString(),
      _origin: 'reddit',
      _category: null,
      // Reddit-specific fields for DB storage
      _subreddit: p.subreddit,
      _redditPostId: p.id,
      _redditPermalink: p.permalink,
      _score: p.score,
      _numComments: p.num_comments,
      _author: p.author,
    }));
  } catch (e) {
    console.error('Failed to fetch Reddit posts:', e.message);
  }
  console.log(`Fetched ${redditPosts.length} Reddit posts`);

  // 4. Combine and deduplicate
  const combined = [...newsArticles, ...redditPosts];
  const deduped = [];
  for (const article of combined) {
    const isDupe = deduped.some(existing =>
      newsService.titlesMatch(existing.title, article.title)
    );
    if (!isDupe) {
      deduped.push(article);
    }
  }

  // Limit to max stories
  const selected = deduped.slice(0, MAX_NEWSLETTER_STORIES);
  console.log(`Selected ${selected.length} stories after deduplication (from ${combined.length} total)`);

  // 5. Fetch article content for external links
  console.log('Fetching article content...');
  for (const article of selected) {
    if (article.url && !article.url.includes('reddit.com')) {
      try {
        const result = await readController.readUrl(article.url, null);
        if (result && result.content) {
          article.content = result.content
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 2000);
        }
      } catch (e) {
        // Content extraction is best-effort
        console.log(`  Could not extract: ${article.url} - ${e.message}`);
      }
    }
  }

  // 6. Generate digest via single batched LLM call
  console.log('Generating newsletter digest via LLM...');
  const digest = await llmService.generateNewsletterDigest(selected);
  console.log(`Digest generated: "${digest.title}"`);

  // 7. Create or update newsletter issue in DB
  let issue;
  if (existing) {
    issue = existing;
    await prisma.newsletterStory.deleteMany({ where: { issueId: issue.id } });
  } else {
    issue = await prisma.newsletterIssue.create({
      data: {
        issueDate: today,
        status: 'DRAFT',
        generatedAt: new Date(),
      },
    });
  }

  // Count sources
  const sourceBreakdown = {};
  for (const a of selected) {
    const origin = a._origin || 'unknown';
    sourceBreakdown[origin] = (sourceBreakdown[origin] || 0) + 1;
  }

  // 8. Save stories
  for (const [index, article] of selected.entries()) {
    const llmStory = digest.stories.find(s => s.index === index) || {};

    await prisma.newsletterStory.create({
      data: {
        issueId: issue.id,
        rank: index + 1,
        origin: article._origin || 'unknown',
        sourceName: article.source || null,
        title: article.title,
        url: article.url || null,
        imageUrl: article.imageUrl || null,
        author: article._author || article.author || null,
        publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
        subreddit: article._subreddit || null,
        redditPostId: article._redditPostId || null,
        redditPermalink: article._redditPermalink || null,
        score: article._score || null,
        numComments: article._numComments || null,
        summary: llmStory.summary || null,
        category: llmStory.category || null,
        significance: llmStory.significance || null,
      },
    });
  }

  // 9. Publish
  await prisma.newsletterIssue.update({
    where: { id: issue.id },
    data: {
      status: 'PUBLISHED',
      title: digest.title,
      executiveSummary: digest.executiveSummary,
      sourceBreakdown,
      llmModel: llmService.MODELS.BATCH,
      generatedAt: new Date(),
      publishedAt: new Date(),
    },
  });

  console.log(`Newsletter published: "${digest.title}"`);

  // 10. Send to subscribers
  const fullIssue = await prisma.newsletterIssue.findUnique({
    where: { id: issue.id },
    include: { stories: { orderBy: { rank: 'asc' } } },
  });

  const subscribers = await prisma.subscription.findMany({
    where: { status: 'ACTIVE' },
  });

  if (subscribers.length > 0) {
    console.log(`Sending newsletter to ${subscribers.length} subscribers...`);
    const result = await emailService.sendNewsletterEmail(subscribers, fullIssue);
    
    await prisma.newsletterIssue.update({
      where: { id: issue.id },
      data: {
        sentAt: new Date(),
        recipientCount: result.sent,
      },
    });

    console.log(`Newsletter sent: ${result.sent} success, ${result.failed} failed`);
  } else {
    console.log('No active subscribers. Newsletter stored but not emailed.');
  }

  await cleanup();
  console.log('Newsletter generation complete!');
}

async function cleanup() {
  await prisma.$disconnect();
  await pool.end();
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  generateNewsletter(force).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = generateNewsletter;
