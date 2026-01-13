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

const STORIES_PER_BRIEFING = 10;
const BRIEFING_INTERVAL_HOURS = 6; // 0:00, 6:00, 12:00, 18:00 UTC

/**
 * Get the current briefing window start time
 * Rounds down to nearest 6-hour interval
 */
function getCurrentBriefingWindow() {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const windowStart = Math.floor(currentHour / BRIEFING_INTERVAL_HOURS) * BRIEFING_INTERVAL_HOURS;
  
  const briefingTime = new Date(now);
  briefingTime.setUTCHours(windowStart, 0, 0, 0);
  return briefingTime;
}

/**
 * Generate the Global Briefing for free users
 * - Fetches top posts from all seeded categories
 * - Uses GPT-5.2 to generate an executive summary
 * - Stores briefing and stories in the database
 */
async function generateGlobalBriefing(force = false) {
  const briefingTime = getCurrentBriefingWindow();
  
  console.log(`Starting Global Briefing Generation for ${briefingTime.toISOString()}`);

  // 1. Check if briefing exists for this window
  const existing = await prisma.globalBriefing.findUnique({
    where: { briefingTime }
  });

  if (existing && existing.status === 'PUBLISHED' && !force) {
    console.log('Briefing already published for this window. Use --force to regenerate.');
    return existing;
  }

  // 2. Get all categories with their subreddits
  const categories = await prisma.category.findMany({
    include: { subreddits: true }
  });

  if (categories.length === 0) {
    console.log('No categories found. Run seed first.');
    await prisma.$disconnect();
    return null;
  }

  console.log(`Found ${categories.length} categories with subreddits`);

  // 3. Fetch top posts from each category's subreddits
  const allCandidates = [];
  
  for (const category of categories) {
    const subredditNames = category.subreddits.map(s => s.name);
    console.log(`Fetching from ${category.name}: ${subredditNames.join(', ')}`);
    
    for (const subreddit of subredditNames) {
      try {
        const posts = await redditService.getTopPosts(subreddit, 5);
        // Tag with category
        posts.forEach(p => {
          p._categoryId = category.id;
          p._categoryName = category.name;
        });
        allCandidates.push(...posts);
      } catch (e) {
        console.error(`Error fetching r/${subreddit}:`, e.message);
      }
    }
  }

  console.log(`Total candidates: ${allCandidates.length}`);

  // 4. Filter: NSFW, minimum engagement, external links or substantial self-posts
  const MIN_SCORE = 100;
  const MIN_COMMENTS = 20;
  
  const filteredCandidates = allCandidates.filter(p => {
    if (p.over_18) return false;
    if (p.score < MIN_SCORE) return false;
    if (p.num_comments < MIN_COMMENTS) return false;
    
    // External link or substantial self-post
    const isExternal = !p.is_self && p.url && !p.url.includes('reddit.com');
    const isSubstantialSelf = p.is_self && p.selftext && p.selftext.length > 200;
    
    return isExternal || isSubstantialSelf;
  });

  console.log(`After filtering: ${filteredCandidates.length} candidates`);

  // 5. Sort by score and deduplicate by post ID
  const seenIds = new Set();
  const dedupedCandidates = filteredCandidates
    .sort((a, b) => b.score - a.score)
    .filter(p => {
      if (seenIds.has(p.id)) return false;
      seenIds.add(p.id);
      return true;
    });

  // 6. Select top stories ensuring category diversity
  const selectedStories = [];
  const categoryCount = {};
  const MAX_PER_CATEGORY = 3;
  
  for (const post of dedupedCandidates) {
    if (selectedStories.length >= STORIES_PER_BRIEFING) break;
    
    const catName = post._categoryName;
    categoryCount[catName] = (categoryCount[catName] || 0) + 1;
    
    if (categoryCount[catName] <= MAX_PER_CATEGORY) {
      selectedStories.push(post);
    }
  }

  // Fill remaining slots if needed
  if (selectedStories.length < STORIES_PER_BRIEFING) {
    const remaining = dedupedCandidates.filter(p => !selectedStories.includes(p));
    selectedStories.push(...remaining.slice(0, STORIES_PER_BRIEFING - selectedStories.length));
  }

  console.log(`Selected ${selectedStories.length} stories for global briefing`);

  // 7. Create or update briefing draft
  let briefing;
  if (existing) {
    briefing = existing;
    await prisma.globalBriefingStory.deleteMany({ where: { briefingId: briefing.id } });
  } else {
    briefing = await prisma.globalBriefing.create({
      data: {
        briefingTime,
        status: 'DRAFT',
        generatedAt: new Date(),
        title: 'Reddit Briefing', // Will be updated after LLM
        executiveSummary: '',
      }
    });
  }

  // 8. Process each story with LLM
  const processedStories = [];
  
  for (const [index, post] of selectedStories.entries()) {
    console.log(`Processing story ${index + 1}/${selectedStories.length}: ${post.title.slice(0, 50)}...`);
    
    // Fetch top comment
    let topComment = null;
    try {
      const comments = await redditService.getPostComments(post.id);
      if (comments.length > 0) {
        topComment = comments[0];
      }
    } catch (e) {
      console.error(`Error fetching comments for ${post.id}:`, e.message);
    }
    
    // Generate analysis (use standard model for individual stories)
    const analysis = await llmService.generateStoryAnalysis(post, topComment ? [topComment] : [], null);
    
    // Extract image URL
    let imageUrl = null;
    if (post.preview?.images?.[0]?.source?.url) {
      imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
    } else if (post.thumbnail && post.thumbnail.startsWith('http')) {
      imageUrl = post.thumbnail;
    }
    
    // Save story
    const story = await prisma.globalBriefingStory.create({
      data: {
        briefingId: briefing.id,
        rank: index + 1,
        categoryId: post._categoryId,
        subreddit: post.subreddit_name_prefixed?.replace('r/', '') || post.subreddit,
        redditPostId: post.id,
        redditPermalink: post.permalink,
        title: post.title,
        postUrl: post.url,
        imageUrl,
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
    
    processedStories.push({
      ...story,
      categoryName: post._categoryName
    });
  }

  // 9. Generate executive summary using GPT-5.2
  console.log('Generating executive summary with GPT-5.2...');
  const { executiveSummary, briefingTitle } = await llmService.generateExecutiveSummary(
    processedStories.map(s => ({
      title: s.title,
      subreddit: s.subreddit,
      score: s.score,
      summary: s.summary
    }))
  );

  // 10. Publish briefing with executive summary
  await prisma.globalBriefing.update({
    where: { id: briefing.id },
    data: {
      title: briefingTitle,
      executiveSummary,
      status: 'PUBLISHED',
      publishedAt: new Date(),
      generatedAt: new Date(),
    }
  });

  console.log(`Global Briefing Published: "${briefingTitle}"`);
  console.log(`Executive Summary: ${executiveSummary.slice(0, 200)}...`);
  
  await prisma.$disconnect();
  return briefing;
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  generateGlobalBriefing(force).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = generateGlobalBriefing;
