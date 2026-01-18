// controllers/forYouController.js
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const OpenAI = require('openai');
const redditService = require('../services/redditService');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Helper to get user from token (via Reddit API)
async function getUserFromToken(token) {
  const response = await fetch('https://oauth.reddit.com/api/v1/me', {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error('Invalid token');
  }

  const redditUser = await response.json();

  // Find or create user
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { redditId: redditUser.id },
        { redditUsername: redditUser.name }
      ]
    }
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        redditId: redditUser.id,
        redditUsername: redditUser.name
      }
    });
  } else if (!user.redditId) {
    // Update legacy user with redditId
    user = await prisma.user.update({
      where: { id: user.id },
      data: { redditId: redditUser.id }
    });
  }

  return { user, redditUser };
}

// Extract Bearer token from Authorization header
function extractToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice(7);
}

// GET /api/foryou/persona
async function getPersona(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const persona = await prisma.userPersona.findUnique({
      where: { userId: user.id }
    });

    if (!persona) {
      return res.json({ persona: null, lastRefreshedAt: null });
    }

    return res.json({
      persona: {
        keywords: persona.keywords,
        topics: persona.topics,
        subredditAffinities: persona.subredditAffinities,
        contentPreferences: persona.contentPreferences
      },
      lastRefreshedAt: persona.updatedAt.toISOString()
    });
  } catch (error) {
    console.error('getPersona error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/foryou/curated
async function getCurated(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const posts = await prisma.curatedPost.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    });

    const savedCount = posts.filter(p => p.action === 'SAVED').length;

    return res.json({
      posts: posts.map(p => ({
        id: p.id,
        redditPostId: p.redditPostId,
        subreddit: p.subreddit,
        title: p.title,
        url: p.url,
        thumbnail: p.thumbnail,
        score: p.score,
        numComments: p.numComments,
        author: p.author,
        createdUtc: p.createdUtc?.toISOString(),
        isSelf: p.isSelf,
        action: p.action.toLowerCase(),
        savedVia: p.savedVia.toLowerCase(),
        curatedAt: p.createdAt.toISOString()
      })),
      count: savedCount,
      limit: 20
    });
  } catch (error) {
    console.error('getCurated error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/foryou/action
async function recordAction(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { redditPostId, action } = req.body;

    if (!redditPostId || !action) {
      return res.status(400).json({ error: 'redditPostId and action required' });
    }

    const validActions = ['saved', 'already_read', 'not_interested'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const { user } = await getUserFromToken(token);

    // Fetch post details from Reddit if we don't have them
    let postData = await prisma.curatedPost.findUnique({
      where: {
        userId_redditPostId: {
          userId: user.id,
          redditPostId
        }
      }
    });

    if (!postData) {
      // Fetch from Reddit
      const response = await fetch(`https://oauth.reddit.com/by_id/${redditPostId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.ok) {
        const data = await response.json();
        const post = data.data?.children?.[0]?.data;

        if (post) {
          postData = await prisma.curatedPost.create({
            data: {
              userId: user.id,
              redditPostId,
              subreddit: post.subreddit,
              title: post.title,
              url: post.url,
              thumbnail: post.thumbnail && !post.thumbnail.includes('self') ? post.thumbnail : null,
              score: post.score,
              numComments: post.num_comments,
              author: post.author,
              createdUtc: new Date(post.created_utc * 1000),
              isSelf: post.is_self,
              action: action.toUpperCase(),
              savedVia: 'REDDZIT'
            }
          });
        }
      }
    } else {
      // Update existing
      postData = await prisma.curatedPost.update({
        where: { id: postData.id },
        data: { action: action.toUpperCase() }
      });
    }

    // If action is 'saved', also save to Reddit
    if (action === 'saved') {
      await fetch('https://oauth.reddit.com/api/save', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `id=${redditPostId}`
      });
    }

    // Count saved posts
    const savedCount = await prisma.curatedPost.count({
      where: {
        userId: user.id,
        action: 'SAVED'
      }
    });

    return res.json({
      success: true,
      curatedCount: savedCount
    });
  } catch (error) {
    console.error('recordAction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/foryou/settings
async function getSettings(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    // Get subreddit post counts from curated posts
    const subredditCounts = await prisma.curatedPost.groupBy({
      by: ['subreddit'],
      where: {
        userId: user.id,
        action: 'SAVED'
      },
      _count: { subreddit: true },
      orderBy: { _count: { subreddit: 'desc' } }
    });

    // Get starred subreddits
    const stars = await prisma.userSubredditStar.findMany({
      where: { userId: user.id }
    });
    const starredSet = new Set(stars.filter(s => s.starred).map(s => s.subreddit));

    // Get persona for recommended subreddits
    const persona = await prisma.userPersona.findUnique({
      where: { userId: user.id }
    });

    const subreddits = subredditCounts.map(s => ({
      name: s.subreddit,
      postCount: s._count.subreddit,
      starred: starredSet.has(s.subreddit)
    }));

    // Generate recommended subreddits based on persona
    let recommendedSubreddits = [];
    if (persona && Array.isArray(persona.subredditAffinities)) {
      recommendedSubreddits = persona.subredditAffinities
        .filter(a => !subredditCounts.some(s => s.subreddit === a.name))
        .slice(0, 10)
        .map(a => a.name);
    }

    return res.json({
      subreddits,
      recommendedSubreddits
    });
  } catch (error) {
    console.error('getSettings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/foryou/settings/star
async function toggleStar(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { subreddit, starred } = req.body;

    if (!subreddit || typeof starred !== 'boolean') {
      return res.status(400).json({ error: 'subreddit and starred required' });
    }

    const { user } = await getUserFromToken(token);

    await prisma.userSubredditStar.upsert({
      where: {
        userId_subreddit: {
          userId: user.id,
          subreddit
        }
      },
      update: { starred },
      create: {
        userId: user.id,
        subreddit,
        starred
      }
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('toggleStar error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/foryou/persona/refresh
async function refreshPersona(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    // Fetch user's saved posts from Reddit (up to 50)
    const savedResponse = await fetch('https://oauth.reddit.com/user/me/saved?limit=50', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!savedResponse.ok) {
      return res.status(502).json({ error: 'Failed to fetch saved posts from Reddit' });
    }

    const savedData = await savedResponse.json();
    const posts = savedData.data?.children || [];

    if (posts.length === 0) {
      return res.status(400).json({ error: 'No saved posts found to analyze' });
    }

    // Take up to 30 posts for analysis
    const postsToAnalyze = posts.slice(0, 30);

    // Build context for LLM analysis
    const postSummaries = postsToAnalyze.map((item, i) => {
      const post = item.data;
      return `${i + 1}. r/${post.subreddit} - "${post.title}"`;
    }).join('\n');

    const subredditCounts = {};
    postsToAnalyze.forEach(item => {
      const sub = item.data.subreddit;
      subredditCounts[sub] = (subredditCounts[sub] || 0) + 1;
    });

    const subredditContext = Object.entries(subredditCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `r/${name}: ${count} posts`)
      .join(', ');

    const PERSONA_PROMPT = `You are an AI assistant analyzing a user's Reddit saved posts to understand their interests. Based on the following saved posts, create a user persona profile.

Saved Posts:
${postSummaries}

Subreddit Distribution: ${subredditContext}

Analyze these posts and respond with valid JSON only:
{
  "keywords": ["5-10 specific interest keywords based on their saved content"],
  "topics": ["3-5 broad topic areas they're interested in"],
  "subredditAffinities": [{"name": "subreddit_name", "weight": 0.0-1.0}],
  "contentPreferences": ["content types they prefer like 'news', 'discussions', 'tutorials', 'memes', 'analysis', etc."]
}

Guidelines:
- keywords should be specific and actionable (e.g., "machine learning", "sourdough baking", "home automation")
- topics should be broader categories (e.g., "Technology", "Cooking", "DIY")
- subredditAffinities should include subreddits they'd likely enjoy, with weights based on how well they match (1.0 = perfect match)
- Include both subreddits from their saved posts AND related subreddits they might enjoy
- contentPreferences should reflect the type of content they engage with`;

    // Check if OpenAI API key is configured
    if (!process.env.OPENAI_API_KEY) {
      console.log('OPENAI_API_KEY not set, using mock persona');
      const mockPersona = {
        keywords: ['reddit', 'saved posts'],
        topics: ['General Interest'],
        subredditAffinities: Object.entries(subredditCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([name, count]) => ({ name, weight: Math.min(1, count / 5) })),
        contentPreferences: ['discussions']
      };

      const persona = await prisma.userPersona.upsert({
        where: { userId: user.id },
        update: {
          keywords: mockPersona.keywords,
          topics: mockPersona.topics,
          subredditAffinities: mockPersona.subredditAffinities,
          contentPreferences: mockPersona.contentPreferences
        },
        create: {
          userId: user.id,
          keywords: mockPersona.keywords,
          topics: mockPersona.topics,
          subredditAffinities: mockPersona.subredditAffinities,
          contentPreferences: mockPersona.contentPreferences
        }
      });

      return res.json({
        persona: {
          keywords: persona.keywords,
          topics: persona.topics,
          subredditAffinities: persona.subredditAffinities,
          contentPreferences: persona.contentPreferences
        },
        lastRefreshedAt: persona.updatedAt.toISOString(),
        postsAnalyzed: postsToAnalyze.length
      });
    }

    // Call OpenAI for persona analysis
    console.log(`Generating persona for user ${user.id} based on ${postsToAnalyze.length} posts`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: PERSONA_PROMPT }
      ],
      temperature: 0.7,
      max_tokens: 1000,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content);

    // Validate and sanitize the response
    const personaData = {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 10) : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 5) : [],
      subredditAffinities: Array.isArray(parsed.subredditAffinities)
        ? parsed.subredditAffinities.map(a => ({
            name: String(a.name || '').replace(/^r\//, ''),
            weight: Math.min(1, Math.max(0, Number(a.weight) || 0.5))
          }))
        : [],
      contentPreferences: Array.isArray(parsed.contentPreferences) ? parsed.contentPreferences : []
    };

    // Upsert the UserPersona record
    const persona = await prisma.userPersona.upsert({
      where: { userId: user.id },
      update: {
        keywords: personaData.keywords,
        topics: personaData.topics,
        subredditAffinities: personaData.subredditAffinities,
        contentPreferences: personaData.contentPreferences
      },
      create: {
        userId: user.id,
        keywords: personaData.keywords,
        topics: personaData.topics,
        subredditAffinities: personaData.subredditAffinities,
        contentPreferences: personaData.contentPreferences
      }
    });

    return res.json({
      persona: {
        keywords: persona.keywords,
        topics: persona.topics,
        subredditAffinities: persona.subredditAffinities,
        contentPreferences: persona.contentPreferences
      },
      lastRefreshedAt: persona.updatedAt.toISOString(),
      postsAnalyzed: postsToAnalyze.length
    });
  } catch (error) {
    console.error('refreshPersona error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/foryou/feed
async function getFeed(req, res) {
  try {
    // a. Extract and validate the Bearer token
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    // b. Get the user's persona for subreddit recommendations
    const persona = await prisma.userPersona.findUnique({
      where: { userId: user.id }
    });

    // c. Get starred subreddits (boosted priority)
    const stars = await prisma.userSubredditStar.findMany({
      where: { userId: user.id, starred: true }
    });
    const starredSubreddits = stars.map(s => s.subreddit);

    // d. Get already curated post IDs to exclude
    const curatedPosts = await prisma.curatedPost.findMany({
      where: { userId: user.id },
      select: { redditPostId: true }
    });
    const curatedPostIds = new Set(curatedPosts.map(p => p.redditPostId));

    // e. Fetch user's subscriptions from Reddit
    let userSubscriptions = [];
    try {
      const subsResponse = await fetch('https://oauth.reddit.com/subreddits/mine/subscriber?limit=100', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (subsResponse.ok) {
        const subsData = await subsResponse.json();
        userSubscriptions = (subsData.data?.children || []).map(c => c.data.display_name);
      }
    } catch (e) {
      console.error('Failed to fetch user subscriptions:', e.message);
    }

    // f. Build a combined list of subreddits (starred first, then persona affinities, then subscriptions)
    const subredditSet = new Set();
    const orderedSubreddits = [];

    // Add starred subreddits first (highest priority)
    for (const sub of starredSubreddits) {
      if (!subredditSet.has(sub)) {
        subredditSet.add(sub);
        orderedSubreddits.push({ name: sub, starred: true });
      }
    }

    // Add persona affinities (sorted by weight)
    if (persona && Array.isArray(persona.subredditAffinities)) {
      const sortedAffinities = [...persona.subredditAffinities].sort((a, b) => (b.weight || 0) - (a.weight || 0));
      for (const affinity of sortedAffinities) {
        if (!subredditSet.has(affinity.name)) {
          subredditSet.add(affinity.name);
          orderedSubreddits.push({ name: affinity.name, starred: false });
        }
      }
    }

    // Add user subscriptions
    for (const sub of userSubscriptions) {
      if (!subredditSet.has(sub)) {
        subredditSet.add(sub);
        orderedSubreddits.push({ name: sub, starred: false });
      }
    }

    // Limit to top 20 subreddits to avoid too many API calls
    const subredditsToFetch = orderedSubreddits.slice(0, 20);

    // g. Fetch top posts from each subreddit using redditService
    const allPosts = [];
    const starredSubredditSet = new Set(starredSubreddits);

    for (const { name: subreddit, starred } of subredditsToFetch) {
      try {
        const posts = await redditService.getTopPosts(subreddit, 5, prisma);
        for (const post of posts) {
          allPosts.push({
            ...post,
            _starred: starred,
            _subreddit: subreddit
          });
        }
      } catch (e) {
        console.error(`Failed to fetch posts from r/${subreddit}:`, e.message);
        // Continue with other subreddits
      }
    }

    // h. Filter out already curated posts
    const filteredPosts = allPosts.filter(post => {
      const fullname = post.name || `t3_${post.id}`;
      return !curatedPostIds.has(fullname);
    });

    // i. Sort by score (with starred subreddit boost)
    const STARRED_BOOST = 2.0; // 2x score boost for starred subreddits
    filteredPosts.sort((a, b) => {
      const scoreA = (a.score || 0) * (a._starred ? STARRED_BOOST : 1);
      const scoreB = (b.score || 0) * (b._starred ? STARRED_BOOST : 1);
      return scoreB - scoreA;
    });

    // j. Return top N posts + recommended subreddits
    const TOP_N = 25;
    const topPosts = filteredPosts.slice(0, TOP_N).map(post => ({
      id: post.id,
      name: post.name || `t3_${post.id}`,
      subreddit: post.subreddit,
      title: post.title,
      url: post.url,
      thumbnail: post.thumbnail && !post.thumbnail.includes('self') && !post.thumbnail.includes('default') ? post.thumbnail : null,
      score: post.score,
      numComments: post.num_comments,
      author: post.author,
      createdUtc: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
      isSelf: post.is_self,
      selftext: post.selftext || null,
      permalink: post.permalink,
      isStarredSubreddit: starredSubredditSet.has(post.subreddit)
    }));

    // Generate recommended subreddits (from persona that aren't already in the feed)
    const feedSubreddits = new Set(topPosts.map(p => p.subreddit));
    let recommendedSubreddits = [];
    if (persona && Array.isArray(persona.subredditAffinities)) {
      recommendedSubreddits = persona.subredditAffinities
        .filter(a => !feedSubreddits.has(a.name) && !starredSubredditSet.has(a.name))
        .slice(0, 5)
        .map(a => a.name);
    }

    return res.json({
      posts: topPosts,
      recommendedSubreddits,
      meta: {
        totalFetched: allPosts.length,
        totalFiltered: filteredPosts.length,
        subredditsFetched: subredditsToFetch.length,
        starredCount: starredSubreddits.length
      }
    });
  } catch (error) {
    console.error('getFeed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  getPersona,
  getCurated,
  recordAction,
  getSettings,
  toggleStar,
  refreshPersona,
  getFeed
};
