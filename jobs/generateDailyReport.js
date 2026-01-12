require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const redditService = require('../services/redditService');
const llmService = require('../services/llmService');
const readController = require('../controllers/readController');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TARGET_SUBREDDITS = ['technology', 'worldnews', 'science', 'programming', 'futurology'];
const STORIES_PER_REPORT = 10;

async function generateDailyReport(force = false) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  console.log(`Starting Daily Report Generation for ${today.toISOString()}`);

  // 1. Check if report exists
  const existing = await prisma.dailyReport.findUnique({
    where: { reportDate: today }
  });

  if (existing && existing.status === 'PUBLISHED' && !force) {
    console.log('Report already published for today. Use --force to regenerate.');
    return;
  }

  // 2. Create Draft Report
  let report;
  if (existing) {
    report = existing;
    // Clear old stories if re-running draft? Or just append?
    // For simplicity, we'll assume we wipe and recreate stories if draft, or just update.
    // Let's delete existing stories for this report to be safe if re-running.
    await prisma.storyComment.deleteMany({ where: { story: { reportId: report.id } } });
    await prisma.reportStory.deleteMany({ where: { reportId: report.id } });
  } else {
    report = await prisma.dailyReport.create({
      data: {
        reportDate: today,
        status: 'DRAFT',
        sourceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        generatedAt: new Date(),
        title: `Daily Pulse — ${today.toLocaleDateString()}`
      }
    });
  }

  // 3. Fetch Candidates
  let candidates = [];
  for (const sub of TARGET_SUBREDDITS) {
    try {
      console.log(`Fetching from r/${sub}...`);
      const posts = await redditService.getTopPosts(sub, 5); // Fetch top 5 from each
      candidates.push(...posts.map(p => ({ ...p, subreddit: sub })));
    } catch (e) {
      console.error(`Error fetching r/${sub}:`, e.message);
    }
  }

  // 4. Rank and Select
  // Simple ranking: score + num_comments
  // De-duplicate by id
  const seenIds = new Set();
  candidates = candidates.filter(p => {
    if (seenIds.has(p.id)) return false;
    seenIds.add(p.id);
    return true;
  });

  candidates.sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments));
  const selectedStories = candidates.slice(0, STORIES_PER_REPORT);

  console.log(`Selected ${selectedStories.length} stories.`);

  // 5. Process Stories
  for (const [index, post] of selectedStories.entries()) {
    console.log(`Processing story ${index + 1}: ${post.title}`);
    
    // Fetch article content
    let articleContent = null;
    if (post.url && !post.url.includes('reddit.com') && !post.url.includes('redd.it')) {
      try {
        console.log(`  Fetching article: ${post.url}`);
        const result = await readController.readUrl(post.url, null);
        if (result && result.content) {
          articleContent = result.content
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 4000);
          console.log(`  Article fetched: ${articleContent.length} chars`);
        }
      } catch (e) {
        console.log(`  Could not fetch article: ${e.message}`);
      }
    }

    // Fetch comments
    let comments = [];
    try {
      comments = await redditService.getPostComments(post.id);
    } catch (e) {
      console.error(`Error fetching comments for ${post.id}:`, e.message);
    }

    // Generate Analysis (now with article content)
    const analysis = await llmService.generateStoryAnalysis(post, comments, articleContent);
    const highlights = await llmService.selectHighlightComments(comments);

    // Extract image URL from Reddit post
    let imageUrl = null;
    if (post.preview?.images?.[0]?.source?.url) {
      // Reddit HTML-encodes the URL, decode it
      imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
    } else if (post.thumbnail && post.thumbnail.startsWith('http')) {
      imageUrl = post.thumbnail;
    }

    // Save Story
    const story = await prisma.reportStory.create({
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
        selectionScore: post.score + post.num_comments,
        summary: analysis.summary,
        sentimentLabel: analysis.sentimentLabel,
        takeaways: analysis.takeaways, // Prisma handles array -> json automatically? No, needs literal value or JSON object
        topicTags: analysis.topicTags,
      }
    });

    // Save Highlights
    for (const h of highlights) {
      await prisma.storyComment.create({
        data: {
          storyId: story.id,
          redditCommentId: h.id,
          redditPermalink: h.permalink,
          author: h.author,
          body: h.body,
          score: h.score,
          createdUtc: new Date(h.created_utc * 1000),
          sampleBucket: 'TOP', // Mock bucket
          positionInBucket: 0,
          isHighlighted: true,
          highlightReason: h.reason
        }
      });
    }
  }

  // 6. Publish Report
  await prisma.dailyReport.update({
    where: { id: report.id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      generatedAt: new Date() // update timestamp
    }
  });

  console.log('Daily Report Generated and Published!');
  await prisma.$disconnect();
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  generateDailyReport(force).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = generateDailyReport;
