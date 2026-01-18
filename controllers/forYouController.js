// controllers/forYouController.js
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

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

module.exports = {
  getPersona,
  getCurated,
  recordAction,
  getSettings,
  toggleStar
};
