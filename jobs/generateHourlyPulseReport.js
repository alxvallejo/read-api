require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const redditService = require('../services/redditService');
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

async function generateHourlyPulseReport(force = false) {
  const reportHour = getCurrentHour();

  console.log(`Starting Hourly Pulse Report Generation for ${reportHour.toISOString()}`);

  // 0. Check if Reddit API is restricted
  const isRestricted = await redditService.isApiRestricted(prisma);
  if (isRestricted) {
    console.log('Reddit API is currently restricted. Skipping Hourly Pulse Report generation.');
    await prisma.$disconnect();
    return;
  }

  // 1. Check if report exists
  const existing = await prisma.hourlyPulseReport.findUnique({
    where: { reportHour }
  });

  if (existing && existing.status === 'PUBLISHED' && !force) {
    console.log('Report already published for this hour. Use --force to regenerate.');
    return;
  }

  // 2. Get today's daily report post IDs to exclude
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const dailyReport = await prisma.dailyReport.findUnique({
    where: { reportDate: today },
    include: { stories: { select: { redditPostId: true } } }
  });
  
  const excludePostIds = new Set(
    dailyReport?.stories?.map(s => s.redditPostId) || []
  );
  console.log(`Excluding ${excludePostIds.size} posts from today's Daily Pulse`);

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
        title: `Hourly Pulse — ${reportHour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      }
    });
  }

  // 4. Fetch top posts from r/all (actual top Reddit posts)
  console.log('Fetching top posts from r/all...');
  let candidates = await redditService.getTopPosts('all', 50);
  
  // 5. Filter NSFW and excluded posts
  candidates = candidates.filter(p => {
    if (p.over_18) return false; // Filter NSFW
    if (excludePostIds.has(p.id)) return false; // Exclude daily pulse posts
    return true;
  });

  // 6. Select top stories
  const selectedStories = candidates.slice(0, STORIES_PER_REPORT);

  console.log(`Selected ${selectedStories.length} stories for hourly pulse report.`);

  // 7. Process stories with LLM and fetch top comment for each
  for (const [index, post] of selectedStories.entries()) {
    console.log(`Processing story ${index + 1}: ${post.title.slice(0, 60)}...`);
    
    // Fetch top comment for this post
    let topComment = null;
    try {
      const comments = await redditService.getPostComments(post.id);
      if (comments.length > 0) {
        // Get the top comment (already sorted by top)
        topComment = comments[0];
      }
    } catch (e) {
      console.error(`Error fetching comments for ${post.id}:`, e.message);
    }
    
    // Generate analysis with the top comment
    const analysis = await llmService.generateStoryAnalysis(post, topComment ? [topComment] : [], null);

    // Extract image URL
    let imageUrl = null;
    if (post.preview?.images?.[0]?.source?.url) {
      imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
    } else if (post.thumbnail && post.thumbnail.startsWith('http')) {
      imageUrl = post.thumbnail;
    }

    // Save story with top comment
    await prisma.hourlyPulseStory.create({
      data: {
        reportId: report.id,
        rank: index + 1,
        subreddit: post.subreddit_name_prefixed?.replace('r/', '') || post.subreddit,
        redditPostId: post.id,
        redditPermalink: post.permalink,
        title: post.title,
        postUrl: post.url,
        imageUrl: imageUrl,
        author: post.author,
        score: post.score,
        numComments: post.num_comments,
        createdUtc: new Date(post.created_utc * 1000),
        summary: analysis.summary,
        sentimentLabel: analysis.sentimentLabel,
        topicTags: analysis.topicTags,
        topCommentAuthor: topComment?.author || null,
        topCommentBody: topComment?.body || null,
        topCommentScore: topComment?.score || null,
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

  console.log('Hourly Pulse Report Generated and Published!');
  await prisma.$disconnect();
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  generateHourlyPulseReport(force).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = generateHourlyPulseReport;
