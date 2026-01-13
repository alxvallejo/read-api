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

const MAX_CATEGORIES = 3;
const STORIES_PER_REPORT = 10;
const POSTS_PER_SUBREDDIT = 5;

// Minimum thresholds for "analyzable" posts
const MIN_SCORE = 50;
const MIN_COMMENTS = 10;
const MIN_SELFTEXT_LENGTH = 500;

/**
 * Filter posts to only those worth analyzing by LLM
 * - Link posts (external articles) are preferred
 * - Self posts need substantial content
 * - Must have engagement above threshold
 * - Exclude media-only posts
 */
function isAnalyzable(post) {
  const isLinkPost = !post.is_self && post.url;
  const hasEngagement = post.score >= MIN_SCORE && post.num_comments >= MIN_COMMENTS;
  
  // Self posts need substantial content to be worth analyzing
  const hasSubstance = post.is_self 
    ? (post.selftext?.length >= MIN_SELFTEXT_LENGTH) 
    : true;
  
  // Exclude media-only posts (images, videos, galleries)
  const isNotMediaOnly = !post.is_video && 
    !post.is_gallery && 
    !post.url?.match(/\.(jpg|jpeg|png|gif|mp4|webm)$/i) &&
    !post.url?.match(/imgur\.com\/[^/]+$/i) &&
    !post.url?.match(/i\.redd\.it/i) &&
    !post.url?.match(/v\.redd\.it/i);

  return (isLinkPost || hasSubstance) && hasEngagement && isNotMediaOnly;
}

/**
 * GET /api/discover/categories
 * Returns all available categories with their subreddits
 */
async function getCategories(req, res) {
  try {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      include: {
        subreddits: {
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
}

/**
 * GET /api/discover/user/:userId/preferences
 * Returns user's selected categories and subreddit toggles
 */
async function getUserPreferences(req, res) {
  try {
    const { userId } = req.params;

    const selections = await prisma.userCategorySelection.findMany({
      where: { userId },
      include: {
        category: {
          include: {
            subreddits: {
              orderBy: { sortOrder: 'asc' },
            },
          },
        },
      },
    });

    // Get user's subreddit toggles
    const toggles = await prisma.userSubredditToggle.findMany({
      where: { userId },
    });

    const toggleMap = {};
    toggles.forEach(t => {
      toggleMap[t.subredditId] = t.enabled;
    });

    // Attach toggle state to each subreddit
    const categories = selections.map(sel => ({
      ...sel.category,
      subreddits: sel.category.subreddits.map(sub => ({
        ...sub,
        enabled: toggleMap[sub.id] !== undefined ? toggleMap[sub.id] : sub.isDefault,
      })),
    }));

    res.json({ 
      selectedCategories: categories,
      categoryCount: categories.length,
      maxCategories: MAX_CATEGORIES,
    });
  } catch (error) {
    console.error('Error fetching user preferences:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
}

/**
 * POST /api/discover/user/:userId/categories
 * Set user's selected categories (replaces existing)
 * Body: { categoryIds: string[] }
 */
async function setUserCategories(req, res) {
  try {
    const { userId } = req.params;
    const { categoryIds } = req.body;

    if (!Array.isArray(categoryIds)) {
      return res.status(400).json({ error: 'categoryIds must be an array' });
    }

    if (categoryIds.length > MAX_CATEGORIES) {
      return res.status(400).json({ 
        error: `Maximum ${MAX_CATEGORIES} categories allowed`,
        maxCategories: MAX_CATEGORIES,
      });
    }

    // Validate category IDs exist
    const validCategories = await prisma.category.findMany({
      where: { id: { in: categoryIds }, isActive: true },
    });

    if (validCategories.length !== categoryIds.length) {
      return res.status(400).json({ error: 'One or more invalid category IDs' });
    }

    // Delete existing selections and create new ones
    await prisma.$transaction([
      prisma.userCategorySelection.deleteMany({ where: { userId } }),
      ...categoryIds.map(categoryId =>
        prisma.userCategorySelection.create({
          data: { userId, categoryId },
        })
      ),
    ]);

    res.json({ success: true, selectedCount: categoryIds.length });
  } catch (error) {
    console.error('Error setting categories:', error);
    res.status(500).json({ error: 'Failed to set categories' });
  }
}

/**
 * POST /api/discover/user/:userId/subreddits/toggle
 * Toggle a subreddit on/off for a user
 * Body: { subredditId: string, enabled: boolean }
 */
async function toggleSubreddit(req, res) {
  try {
    const { userId } = req.params;
    const { subredditId, enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    await prisma.userSubredditToggle.upsert({
      where: {
        userId_subredditId: { userId, subredditId },
      },
      update: { enabled },
      create: { userId, subredditId, enabled },
    });

    res.json({ success: true, subredditId, enabled });
  } catch (error) {
    console.error('Error toggling subreddit:', error);
    res.status(500).json({ error: 'Failed to toggle subreddit' });
  }
}

/**
 * POST /api/discover/user/:userId/generate
 * Manually trigger report generation for user
 */
async function generateReport(req, res) {
  try {
    const { userId } = req.params;

    // Check if Reddit API is restricted
    const isRestricted = await redditService.isApiRestricted(prisma);
    if (isRestricted) {
      return res.status(503).json({
        error: 'Reddit API is temporarily unavailable. Please try again later.',
        restricted: true,
      });
    }

    // Get user's selected categories
    const selections = await prisma.userCategorySelection.findMany({
      where: { userId },
      include: {
        category: {
          include: {
            subreddits: true,
          },
        },
      },
    });

    if (selections.length === 0) {
      return res.status(400).json({ 
        error: 'No categories selected. Please select at least one category first.' 
      });
    }

    // Get user's subreddit toggles
    const toggles = await prisma.userSubredditToggle.findMany({
      where: { userId },
    });
    const toggleMap = {};
    toggles.forEach(t => {
      toggleMap[t.subredditId] = t.enabled;
    });

    // Build list of enabled subreddits
    const enabledSubreddits = [];
    const categoryNames = [];

    for (const sel of selections) {
      categoryNames.push(sel.category.name);
      for (const sub of sel.category.subreddits) {
        const isEnabled = toggleMap[sub.id] !== undefined 
          ? toggleMap[sub.id] 
          : sub.isDefault;
        if (isEnabled) {
          enabledSubreddits.push(sub.name);
        }
      }
    }

    if (enabledSubreddits.length === 0) {
      return res.status(400).json({ 
        error: 'All subreddits are disabled. Please enable at least one subreddit.' 
      });
    }

    console.log(`Generating discover report for user ${userId}`);
    console.log(`Categories: ${categoryNames.join(', ')}`);
    console.log(`Subreddits: ${enabledSubreddits.join(', ')}`);

    // Create draft report
    const report = await prisma.discoverReport.create({
      data: {
        userId,
        status: 'DRAFT',
        generatedAt: new Date(),
        title: `Discover — ${new Date().toLocaleDateString()}`,
        sourceCategories: categoryNames,
        sourceSubreddits: enabledSubreddits,
      },
    });

    // Fetch posts from all enabled subreddits
    let candidates = [];
    for (const subName of enabledSubreddits) {
      try {
        console.log(`  Fetching from r/${subName}...`);
        const posts = await redditService.getTopPosts(subName, POSTS_PER_SUBREDDIT, prisma);
        candidates.push(...posts.map(p => ({ ...p, subreddit: subName })));
      } catch (e) {
        console.error(`  Error fetching r/${subName}:`, e.message);
      }
    }

    console.log(`  Fetched ${candidates.length} total posts`);

    // Deduplicate by post ID
    const seenIds = new Set();
    candidates = candidates.filter(p => {
      if (seenIds.has(p.id)) return false;
      seenIds.add(p.id);
      return true;
    });

    // Filter for analyzable posts
    const analyzable = candidates.filter(isAnalyzable);
    console.log(`  ${analyzable.length} posts pass analyzability filter`);

    // Sort by score and select top N
    analyzable.sort((a, b) => b.score - a.score);
    const selectedStories = analyzable.slice(0, STORIES_PER_REPORT);

    if (selectedStories.length === 0) {
      await prisma.discoverReport.update({
        where: { id: report.id },
        data: { status: 'FAILED' },
      });
      return res.status(400).json({ 
        error: 'No suitable posts found. Try selecting different categories or waiting for new content.' 
      });
    }

    console.log(`  Processing ${selectedStories.length} stories with LLM...`);

    // Process each story with LLM and fetch top comment
    for (const [index, post] of selectedStories.entries()) {
      console.log(`  [${index + 1}/${selectedStories.length}] ${post.title.slice(0, 50)}...`);

      // Fetch top comment for this post
      let topComment = null;
      try {
        const comments = await redditService.getPostComments(post.id, prisma);
        if (comments.length > 0) {
          topComment = comments[0];
        }
      } catch (e) {
        console.error(`    Error fetching comments for ${post.id}:`, e.message);
      }

      const analysis = await llmService.generateStoryAnalysis(post, topComment ? [topComment] : [], null);

      // Extract image URL
      let imageUrl = null;
      if (post.preview?.images?.[0]?.source?.url) {
        imageUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
      } else if (post.thumbnail && post.thumbnail.startsWith('http')) {
        imageUrl = post.thumbnail;
      }

      await prisma.discoverStory.create({
        data: {
          reportId: report.id,
          rank: index + 1,
          subreddit: post.subreddit,
          redditPostId: post.id,
          redditPermalink: post.permalink,
          title: post.title,
          postUrl: post.url,
          imageUrl,
          author: post.author,
          score: post.score,
          numComments: post.num_comments,
          createdUtc: new Date(post.created_utc * 1000),
          isSelfPost: post.is_self || false,
          summary: analysis.summary,
          sentimentLabel: analysis.sentimentLabel,
          topicTags: analysis.topicTags,
          topCommentAuthor: topComment?.author || null,
          topCommentBody: topComment?.body || null,
          topCommentScore: topComment?.score || null,
        },
      });
    }

    // Mark report as published
    const publishedReport = await prisma.discoverReport.update({
      where: { id: report.id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        llmModel: 'gpt-4o-mini',
      },
      include: {
        stories: {
          orderBy: { rank: 'asc' },
        },
      },
    });

    console.log(`Report generated successfully: ${publishedReport.id}`);

    res.json({ 
      success: true, 
      report: publishedReport,
    });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
}

/**
 * GET /api/discover/user/:userId/reports
 * Get user's generated reports
 */
async function getUserReports(req, res) {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 10;

    const reports = await prisma.discoverReport.findMany({
      where: { userId, status: 'PUBLISHED' },
      include: {
        stories: {
          orderBy: { rank: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({ reports });
  } catch (error) {
    console.error('Error fetching user reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
}

/**
 * GET /api/discover/user/:userId/reports/latest
 * Get user's most recent report
 */
async function getLatestReport(req, res) {
  try {
    const { userId } = req.params;

    const report = await prisma.discoverReport.findFirst({
      where: { userId, status: 'PUBLISHED' },
      include: {
        stories: {
          orderBy: { rank: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!report) {
      return res.status(404).json({ error: 'No reports found' });
    }

    res.json({ report });
  } catch (error) {
    console.error('Error fetching latest report:', error);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
}

module.exports = {
  getCategories,
  getUserPreferences,
  setUserCategories,
  toggleSubreddit,
  generateReport,
  getUserReports,
  getLatestReport,
};
