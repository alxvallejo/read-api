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
const SUBREDDITS_TO_SAMPLE = 6;
const POSTS_PER_SUBREDDIT = 4;

// Fetch popular subreddits from Reddit using authenticated API
async function getPopularSubreddits(limit = 50) {
  const fetch = require('node-fetch');
  const UA = process.env.USER_AGENT || 'Reddzit/1.0';
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  
  // Get access token
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: 'grant_type=client_credentials',
  });
  
  if (!tokenRes.ok) {
    throw new Error(`Failed to get Reddit access token: ${tokenRes.statusText}`);
  }
  
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  
  // Fetch popular subreddits with auth
  const response = await fetch(`https://oauth.reddit.com/subreddits/popular?limit=${limit}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': UA
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch popular subreddits: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data.children
    .filter(c => !c.data.over18) // Filter NSFW
    .map(c => c.data.display_name);
}

// Get current hour truncated timestamp
function getCurrentHour() {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  return now;
}

async function generateHourlyReport(force = false) {
  const reportHour = getCurrentHour();

  console.log(`Starting Hourly Report Generation for ${reportHour.toISOString()}`);

  // 0. Check if Reddit API is restricted
  const isRestricted = await redditService.isApiRestricted(prisma);
  if (isRestricted) {
    console.log('Reddit API is currently restricted. Skipping Hourly Report generation.');
    await prisma.$disconnect();
    return;
  }

  // 1. Check if report exists
  const existing = await prisma.hourlyReport.findUnique({
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

  // 3. Get popular subreddits and randomly sample
  const allPopularSubs = await getPopularSubreddits(50);
  const shuffled = allPopularSubs.sort(() => Math.random() - 0.5);
  const selectedSubs = shuffled.slice(0, SUBREDDITS_TO_SAMPLE);
  
  console.log(`Selected subreddits: ${selectedSubs.join(', ')}`);

  // 4. Create or update draft report
  let report;
  if (existing) {
    report = existing;
    // Clear old stories if re-running
    await prisma.hourlyStory.deleteMany({ where: { reportId: report.id } });
  } else {
    report = await prisma.hourlyReport.create({
      data: {
        reportHour,
        status: 'DRAFT',
        generatedAt: new Date(),
        sourceSubreddits: selectedSubs,
        title: `Discover — ${reportHour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      }
    });
  }

  // 5. Fetch posts from selected subreddits
  let candidates = [];
  for (const sub of selectedSubs) {
    try {
      console.log(`Fetching from r/${sub}...`);
      const posts = await redditService.getTopPosts(sub, POSTS_PER_SUBREDDIT);
      candidates.push(...posts.map(p => ({ ...p, subreddit: sub })));
    } catch (e) {
      console.error(`Error fetching r/${sub}:`, e.message);
    }
  }

  // 6. Deduplicate and filter
  const seenIds = new Set();
  candidates = candidates.filter(p => {
    if (seenIds.has(p.id)) return false;
    if (excludePostIds.has(p.id)) return false; // Exclude daily pulse posts
    seenIds.add(p.id);
    return true;
  });

  // 7. Rank by engagement and select top stories
  candidates.sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments));
  const selectedStories = candidates.slice(0, STORIES_PER_REPORT);

  console.log(`Selected ${selectedStories.length} stories for hourly report.`);

  // 8. Process stories with LLM (lighter analysis - no comments)
  for (const [index, post] of selectedStories.entries()) {
    console.log(`Processing story ${index + 1}: ${post.title.slice(0, 60)}...`);
    
    // Generate lighter analysis (no comment fetching for hourly)
    const analysis = await llmService.generateStoryAnalysis(post, [], null);

    // Extract image URL
    let imageUrl = null;
    if (post.preview?.images?.[0]?.source?.url) {
      imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
    } else if (post.thumbnail && post.thumbnail.startsWith('http')) {
      imageUrl = post.thumbnail;
    }

    // Save story
    await prisma.hourlyStory.create({
      data: {
        reportId: report.id,
        rank: index + 1,
        subreddit: post.subreddit,
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
      }
    });
  }

  // 9. Publish report
  await prisma.hourlyReport.update({
    where: { id: report.id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      generatedAt: new Date(),
      sourceSubreddits: selectedSubs
    }
  });

  console.log('Hourly Report Generated and Published!');
  await prisma.$disconnect();
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  generateHourlyReport(force).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = generateHourlyReport;
