require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const rssService = require('../services/rssService');
const llmService = require('../services/llmService');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const STORIES_PER_REPORT = 12;

// Get current hour truncated timestamp
function getCurrentHour() {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  return now;
}

async function generateTopPostsReport(force = false) {
  const reportHour = getCurrentHour();

  console.log(`Starting Top Posts Report Generation for ${reportHour.toISOString()}`);

  // 1. Check if report exists
  const existing = await prisma.hourlyPulseReport.findUnique({
    where: { reportHour }
  });

  if (existing && existing.status === 'PUBLISHED' && !force) {
    console.log('Report already published for this hour. Use --force to regenerate.');
    await prisma.$disconnect();
    return;
  }

  // 2. Get today's daily report post IDs to exclude (if any)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dailyReport = await prisma.dailyReport.findUnique({
    where: { reportDate: today },
    include: { stories: { select: { redditPostId: true } } }
  });

  const excludePostIds = new Set(
    dailyReport?.stories?.map(s => s.redditPostId) || []
  );
  console.log(`Excluding ${excludePostIds.size} posts from today's Daily Report`);

  // 3. Create or update draft report
  let report;
  if (existing) {
    report = existing;
    // Clear old stories if re-running
    await prisma.hourlyPulseStory.deleteMany({ where: { reportId: report.id } });
  } else {
    report = await prisma.hourlyPulseReport.create({
      data: {
        reportHour,
        status: 'DRAFT',
        generatedAt: new Date(),
        title: `Top Posts — ${reportHour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      }
    });
  }

  // 4. Fetch top posts from r/all using RSS feed (JSON endpoint blocked on server)
  console.log('Fetching top posts from r/all via RSS...');
  let candidates;
  try {
    candidates = await rssService.getTrendingFromRSS('all', 50);
  } catch (error) {
    console.error('Failed to fetch posts:', error.message);
    await prisma.$disconnect();
    return;
  }

  // 5. Filter excluded posts (extract post ID from RSS link for comparison)
  candidates = candidates.filter(p => {
    let postId = p.id;
    if (p.link) {
      const match = p.link.match(/\/comments\/([a-z0-9]+)/i);
      if (match) postId = match[1];
    }
    return !excludePostIds.has(postId);
  });

  // 6. Select top stories
  const selectedStories = candidates.slice(0, STORIES_PER_REPORT);

  console.log(`Selected ${selectedStories.length} stories for top posts report.`);

  // 7. Process stories with LLM (no comments since we're using RSS)
  for (const [index, post] of selectedStories.entries()) {
    console.log(`Processing story ${index + 1}: ${post.title.slice(0, 60)}...`);

    // Generate analysis without comments
    const analysis = await llmService.generateStoryAnalysis(post, [], null);

    // Extract permalink path from RSS link (e.g., https://www.reddit.com/r/... -> /r/...)
    let permalink = null;
    if (post.link) {
      try {
        const url = new URL(post.link);
        permalink = url.pathname;
      } catch {
        permalink = post.link;
      }
    }

    // Extract post ID from RSS id or link
    // RSS id is often the full URL, we need just the post ID (e.g., "abc123")
    let postId = post.id;
    if (post.link) {
      const match = post.link.match(/\/comments\/([a-z0-9]+)/i);
      if (match) {
        postId = match[1];
      }
    }

    // Save story (RSS has limited data - no score, comments, or images)
    await prisma.hourlyPulseStory.create({
      data: {
        reportId: report.id,
        rank: index + 1,
        subreddit: post.subreddit,
        redditPostId: postId,
        redditPermalink: permalink,
        title: post.title,
        postUrl: post.link, // RSS link is the Reddit post URL
        imageUrl: null, // RSS doesn't include images
        author: post.author,
        score: 0, // RSS doesn't include score
        numComments: 0, // RSS doesn't include comment count
        createdUtc: post.pubDate ? new Date(post.pubDate) : new Date(),
        summary: analysis.summary,
        sentimentLabel: analysis.sentimentLabel,
        topicTags: analysis.topicTags,
        topCommentAuthor: null,
        topCommentBody: null,
        topCommentScore: null,
      }
    });
  }

  // 8. Publish report
  await prisma.hourlyPulseReport.update({
    where: { id: report.id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      generatedAt: new Date(),
    }
  });

  console.log('Top Posts Report Generated and Published!');
  await prisma.$disconnect();
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  generateTopPostsReport(force).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = generateTopPostsReport;
