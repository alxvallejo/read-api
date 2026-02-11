// controllers/forYouController.js
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const OpenAI = require('openai');
const rssService = require('../services/rssService');
const { getAppOnlyAccessToken } = require('./redditProxyController');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Helper to get user from token (via Reddit API)
const USER_AGENT = process.env.USER_AGENT || 'Reddzit/1.0';

// Helper to decode HTML entities in Reddit titles
function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

async function getUserFromToken(token) {
  const response = await fetch('https://oauth.reddit.com/api/v1/me', {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT
    }
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
    console.log('recordAction received:', { redditPostId, action });

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
      // Fetch from Reddit - need t3_ prefix for the API
      const fullname = redditPostId.startsWith('t3_') ? redditPostId : `t3_${redditPostId}`;
      const response = await fetch(`https://oauth.reddit.com/by_id/${fullname}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT
        }
      });

      console.log(`Fetching post from Reddit: /by_id/${fullname}, status: ${response.status}`);

      if (response.ok) {
        const data = await response.json();
        const post = data.data?.children?.[0]?.data;
        console.log('Reddit returned post:', post ? post.title : 'null');

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
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
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

    // Invalidate feed cache so the post doesn't reappear
    await prisma.user.update({
      where: { id: user.id },
      data: { cachedFeed: null }
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

// POST /api/foryou/subscriptions/sync
async function syncSubscriptions(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    // Fetch ALL user's subscriptions from Reddit (paginated)
    const allSubreddits = [];
    let after = null;
    let pageCount = 0;
    const maxPages = 10; // Safety limit: 10 pages * 100 = 1000 max subscriptions

    do {
      const url = `https://oauth.reddit.com/subreddits/mine/subscriber?limit=100${after ? `&after=${after}` : ''}`;
      const subsResponse = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT
        }
      });

      if (!subsResponse.ok) {
        return res.status(502).json({ error: 'Failed to fetch subscriptions from Reddit' });
      }

      const subsData = await subsResponse.json();
      const pageSubreddits = (subsData.data?.children || []).map(c => c.data.display_name);
      allSubreddits.push(...pageSubreddits);

      after = subsData.data?.after;
      pageCount++;
    } while (after && pageCount < maxPages);

    // Deduplicate subreddits
    const subreddits = [...new Set(allSubreddits)];

    // Delete old subscriptions and insert new ones in a transaction
    await prisma.$transaction(async (tx) => {
      await tx.userSubscription.deleteMany({
        where: { userId: user.id }
      });

      if (subreddits.length > 0) {
        await tx.userSubscription.createMany({
          data: subreddits.map(subreddit => ({
            userId: user.id,
            subreddit
          })),
          skipDuplicates: true
        });
      }
    });

    console.log(`Synced ${subreddits.length} subscriptions for user ${user.id} (${pageCount} pages)`);
    return res.json({
      success: true,
      count: subreddits.length,
      subreddits
    });
  } catch (error) {
    console.error('syncSubscriptions error:', error);
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

    const { user, redditUser } = await getUserFromToken(token);

    // Fetch user's saved posts from Reddit (up to 50)
    // Note: Must use username, not "me" - Reddit API quirk
    const savedResponse = await fetch(`https://oauth.reddit.com/user/${redditUser.name}/saved?limit=50`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT
      }
    });

    if (!savedResponse.ok) {
      const errorText = await savedResponse.text();
      console.error('Reddit saved posts error:', savedResponse.status, errorText);
      return res.status(502).json({ error: `Failed to fetch saved posts from Reddit: ${savedResponse.status}` });
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
          contentPreferences: mockPersona.contentPreferences,
          analyzedPostCount: postsToAnalyze.length
        },
        create: {
          userId: user.id,
          keywords: mockPersona.keywords,
          topics: mockPersona.topics,
          subredditAffinities: mockPersona.subredditAffinities,
          contentPreferences: mockPersona.contentPreferences,
          analyzedPostCount: postsToAnalyze.length
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
        contentPreferences: personaData.contentPreferences,
        analyzedPostCount: postsToAnalyze.length
      },
      create: {
        userId: user.id,
        keywords: personaData.keywords,
        topics: personaData.topics,
        subredditAffinities: personaData.subredditAffinities,
        contentPreferences: personaData.contentPreferences,
        analyzedPostCount: postsToAnalyze.length
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

// POST /api/foryou/report/generate
async function generateReport(req, res) {
  try {
    // a. Extract and validate the Bearer token
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    // Check if previous report is older than 18 hours - if so, clear skipped posts
    const existingReport = await prisma.forYouReport.findUnique({
      where: { userId: user.id }
    });

    if (existingReport) {
      const hoursSinceLastReport = (Date.now() - existingReport.generatedAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastReport > 18) {
        const [deletedPosts, deactivatedBlocks] = await Promise.all([
          prisma.curatedPost.deleteMany({
            where: {
              userId: user.id,
              action: { in: ['ALREADY_READ', 'NOT_INTERESTED'] }
            }
          }),
          prisma.userBlockedSubreddit.updateMany({
            where: { userId: user.id, isActive: true },
            data: { isActive: false }
          })
        ]);
        console.log(`Cleared ${deletedPosts.count} skipped posts and deactivated ${deactivatedBlocks.count} blocked subreddits for user ${user.id} (report was ${Math.round(hoursSinceLastReport)}h old)`);
      }
    }

    // b. Get the selected model from request body
    const { model: selectedModel } = req.body;
    const validModels = ['gpt-4o-mini', 'gpt-4o', 'gpt-5.2'];
    const model = validModels.includes(selectedModel) ? selectedModel : 'gpt-4o-mini';

    // c. Get user's saved curated posts (action = SAVED)
    const savedPosts = await prisma.curatedPost.findMany({
      where: {
        userId: user.id,
        action: 'SAVED'
      },
      orderBy: { createdAt: 'desc' }
    });

    // d. If no saved posts, return 400 error
    if (savedPosts.length === 0) {
      return res.status(400).json({ error: 'No saved posts to generate report from. Save some posts first!' });
    }

    // e. Build a prompt asking the LLM to create a reading digest
    const postSummaries = savedPosts.map((post, i) => {
      return `${i + 1}. r/${post.subreddit} - "${post.title}"${post.url ? ` (${post.url})` : ''}`;
    }).join('\n');

    const REPORT_PROMPT = `You are creating a personalized reading digest for a user based on their saved Reddit posts. Create an engaging, well-organized report that helps them get the most value from their curated reading list.

Saved Posts:
${postSummaries}

Create a reading digest with the following structure:

1. **Group posts by theme/topic** (NOT by subreddit) - Find common themes across different subreddits and organize posts into logical groups
2. **Provide brief summaries for each group** - Explain what connects the posts and what the user might learn
3. **Highlight the most interesting finds** - Call out 2-3 posts that seem particularly valuable or noteworthy
4. **Suggest a reading order** - If applicable, suggest an order that builds knowledge progressively

Use markdown formatting for readability:
- Use headers (##) for theme groups
- Use bullet points for post lists within groups
- Use **bold** for emphasis on key insights
- Include the subreddit in parentheses after each post title

Keep the tone friendly and helpful. Make it feel like a personalized newsletter.`;

    // f. Call OpenAI with the selected model
    let reportContent;

    if (!process.env.OPENAI_API_KEY) {
      console.log('OPENAI_API_KEY not set, using mock report');
      reportContent = `# Your Reading Digest

## Posts to Review

${savedPosts.map((p, i) => `${i + 1}. **${p.title}** (r/${p.subreddit})`).join('\n')}

---
*Note: This is a placeholder report. Configure OPENAI_API_KEY for AI-generated digests.*`;
    } else {
      console.log(`Generating report for user ${user.id} with ${savedPosts.length} posts using ${model}`);

      const response = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: 'user', content: REPORT_PROMPT }
        ],
        temperature: 0.7,
        max_tokens: 2000
      });

      reportContent = response.choices[0]?.message?.content;
      if (!reportContent) {
        throw new Error('Empty response from OpenAI');
      }
    }

    // g. Save the report to ForYouReport table (one report per user)
    const report = await prisma.forYouReport.upsert({
      where: { userId: user.id },
      update: {
        model: model,
        postCount: savedPosts.length,
        content: reportContent,
        status: 'PUBLISHED',
        generatedAt: new Date()
      },
      create: {
        userId: user.id,
        model: model,
        postCount: savedPosts.length,
        content: reportContent,
        status: 'PUBLISHED',
        generatedAt: new Date()
      }
    });

    // h. Mark the saved posts as ALREADY_READ (they've been processed)
    await prisma.curatedPost.updateMany({
      where: {
        userId: user.id,
        action: 'SAVED'
      },
      data: {
        action: 'ALREADY_READ'
      }
    });

    // Invalidate feed cache so next feed request fetches fresh posts
    await prisma.user.update({ where: { id: user.id }, data: { cachedFeed: null } });

    // i. Return the report
    return res.json({
      report: {
        id: report.id,
        content: report.content,
        model: report.model,
        postCount: report.postCount,
        generatedAt: report.generatedAt.toISOString()
      }
    });
  } catch (error) {
    console.error('generateReport error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/foryou/report
async function getReport(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const report = await prisma.forYouReport.findUnique({
      where: { userId: user.id }
    });

    if (!report) {
      return res.json({ report: null });
    }

    // Treat reports older than 18 hours as stale
    const hoursSinceReport = (Date.now() - report.generatedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceReport > 18) {
      return res.json({ report: null });
    }

    return res.json({
      report: {
        id: report.id,
        content: report.content,
        model: report.model,
        postCount: report.postCount,
        generatedAt: report.generatedAt.toISOString()
      }
    });
  } catch (error) {
    console.error('getReport error:', error);
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

    // Check database cache first (unless ?refresh=true)
    const skipCache = req.query.refresh === 'true';

    if (!skipCache && user.cachedFeed) {
      console.log(`[Cache HIT] Feed for user ${user.id}`);
      return res.json(user.cachedFeed);
    }
    console.log(`[Cache MISS] Feed for user ${user.id}`);

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

    // e. Get user's subscriptions from database (synced via settings)
    const storedSubscriptions = await prisma.userSubscription.findMany({
      where: { userId: user.id },
      select: { subreddit: true }
    });
    const userSubscriptions = storedSubscriptions.map(s => s.subreddit);

    // e2. Get "not interested" counts by subreddit to penalize/block
    const notInterestedCounts = await prisma.curatedPost.groupBy({
      by: ['subreddit'],
      where: {
        userId: user.id,
        action: 'NOT_INTERESTED'
      },
      _count: { subreddit: true }
    });

    // e3. Get blocked subreddits (active blocks and historical block counts)
    const blockedRecords = await prisma.userBlockedSubreddit.findMany({
      where: { userId: user.id },
      select: { subreddit: true, isActive: true, blockCount: true }
    });

    // Build sets for blocked (active OR 5+ not interested) and penalized subreddits
    const blockedSubreddits = new Set();
    const penalizedSubreddits = new Map(); // subreddit -> penalty multiplier

    // Add actively blocked subreddits
    for (const record of blockedRecords) {
      if (record.isActive) {
        blockedSubreddits.add(record.subreddit);
      } else if (record.blockCount >= 1) {
        // Previously blocked subreddits get penalized based on block count
        // blockCount 1 = 0.7x weight, 2 = 0.5x, 3+ = 0.3x
        const penalty = record.blockCount >= 3 ? 0.3 : record.blockCount >= 2 ? 0.5 : 0.7;
        penalizedSubreddits.set(record.subreddit, penalty);
      }
    }

    // Add NOT_INTERESTED based blocks/penalties
    for (const item of notInterestedCounts) {
      const count = item._count.subreddit;
      if (count >= 5) {
        blockedSubreddits.add(item.subreddit);
        console.log(`Blocking r/${item.subreddit} (${count} not interested)`);
      } else if (count >= 3 && !penalizedSubreddits.has(item.subreddit)) {
        penalizedSubreddits.set(item.subreddit, 0.5);
        console.log(`Penalizing r/${item.subreddit} (${count} not interested)`);
      }
    }

    // f. Build a combined list of subreddits (starred first, then persona affinities, then subscriptions)
    const subredditSet = new Set();
    const orderedSubreddits = [];

    // Add starred subreddits first (highest priority) - skip blocked
    for (const sub of starredSubreddits) {
      if (!subredditSet.has(sub) && !blockedSubreddits.has(sub)) {
        subredditSet.add(sub);
        orderedSubreddits.push({ name: sub, starred: true });
      }
    }

    // Add persona affinities (sorted by weight) - skip blocked, deprioritize penalized
    if (persona && Array.isArray(persona.subredditAffinities)) {
      const sortedAffinities = [...persona.subredditAffinities].sort((a, b) => {
        const penaltyA = penalizedSubreddits.get(a.name) || 1;
        const penaltyB = penalizedSubreddits.get(b.name) || 1;
        const weightA = (a.weight || 0) * penaltyA;
        const weightB = (b.weight || 0) * penaltyB;
        return weightB - weightA;
      });
      for (const affinity of sortedAffinities) {
        if (!subredditSet.has(affinity.name) && !blockedSubreddits.has(affinity.name)) {
          subredditSet.add(affinity.name);
          orderedSubreddits.push({ name: affinity.name, starred: false });
        }
      }
    }

    // Add user subscriptions - skip blocked
    for (const sub of userSubscriptions) {
      if (!subredditSet.has(sub) && !blockedSubreddits.has(sub)) {
        subredditSet.add(sub);
        orderedSubreddits.push({ name: sub, starred: false });
      }
    }

    // Limit to top 10 subreddits for speed
    const subredditsToFetch = orderedSubreddits.slice(0, 10);

    console.log('getFeed debug:', {
      userId: user.id,
      starredCount: starredSubreddits.length,
      personaAffinitiesCount: persona?.subredditAffinities?.length || 0,
      subscriptionsCount: userSubscriptions.length,
      subredditsToFetch: subredditsToFetch.map(s => s.name)
    });

    // g. Fetch top posts from each subreddit using OAuth API (more reliable on production)
    const starredSubredditSet = new Set(starredSubreddits);

    const fetchPromises = subredditsToFetch.map(async ({ name: subreddit, starred }) => {
      try {
        // Use OAuth API with user's token - more reliable than public JSON on cloud hosts
        const response = await fetch(`https://oauth.reddit.com/r/${subreddit}/hot?limit=10`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': USER_AGENT
          }
        });

        if (!response.ok) {
          console.error(`OAuth fetch failed for r/${subreddit}: ${response.status}`);
          return [];
        }

        const data = await response.json();
        const posts = data.data.children
          .filter(child => child.kind === 't3')
          .map(child => child.data)
          .filter(post => !post.over_18);

        return posts.map(post => ({
          ...post,
          _starred: starred,
          _subreddit: subreddit
        }));
      } catch (e) {
        // Silently skip failed subreddits (private, banned, etc.)
        console.error(`Failed to fetch r/${subreddit}:`, e.message);
        return [];
      }
    });

    const results = await Promise.all(fetchPromises);
    const allPosts = results.flat();

    console.log('getFeed results:', {
      totalPostsFetched: allPosts.length,
      curatedPostsToExclude: curatedPostIds.size
    });

    // h. Filter out already curated posts
    console.log('Curated post IDs to exclude:', Array.from(curatedPostIds));
    // Debug: log first post structure
    if (allPosts.length > 0) {
      console.log('Sample post structure:', { name: allPosts[0].name, id: allPosts[0].id });
    }
    const filteredPosts = allPosts.filter(post => {
      const fullname = post.name || `t3_${post.id}`;
      // Strip t3_ prefix to match stored redditPostId format
      const postId = fullname.startsWith('t3_') ? fullname.slice(3) : fullname;
      const shouldExclude = curatedPostIds.has(postId);
      if (shouldExclude) {
        console.log(`Excluding post: ${postId}`);
      }
      return !shouldExclude;
    });
    console.log(`Filtered ${allPosts.length - filteredPosts.length} curated posts`);

    // i. Sort by score (with starred subreddit boost)
    const STARRED_BOOST = 2.0; // 2x score boost for starred subreddits
    filteredPosts.sort((a, b) => {
      const scoreA = (a.score || 0) * (a._starred ? STARRED_BOOST : 1);
      const scoreB = (b.score || 0) * (b._starred ? STARRED_BOOST : 1);
      return scoreB - scoreA;
    });

    // j. Return top N posts + recommended subreddits
    const TOP_N = 25;
    const topPosts = filteredPosts.slice(0, TOP_N).map(post => {
      // Extract the post ID (without t3_ prefix) for redditPostId
      const fullname = post.name || `t3_${post.id}`;
      const redditPostId = fullname.startsWith('t3_') ? fullname.slice(3) : fullname;

      return {
        id: post.id,
        redditPostId: redditPostId,
        subreddit: post.subreddit,
        title: post.title,
        url: post.url,
        thumbnail: post.thumbnail && !post.thumbnail.includes('self') && !post.thumbnail.includes('default') ? post.thumbnail : null,
        score: post.score,
        numComments: post.num_comments,
        author: post.author,
        createdUtc: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        isSelf: post.is_self
      };
    });

    // Generate recommended subreddits (from persona that aren't already in the feed)
    const feedSubreddits = new Set(topPosts.map(p => p.subreddit));
    let recommendedSubreddits = [];
    if (persona && Array.isArray(persona.subredditAffinities)) {
      recommendedSubreddits = persona.subredditAffinities
        .filter(a => !feedSubreddits.has(a.name) && !starredSubredditSet.has(a.name))
        .slice(0, 5)
        .map(a => a.name);
    }

    const response = {
      posts: topPosts,
      recommendedSubreddits,
      meta: {
        totalFetched: allPosts.length,
        totalFiltered: filteredPosts.length,
        subredditsFetched: subredditsToFetch.length,
        starredCount: starredSubreddits.length
      }
    };

    // Cache the response in database
    await prisma.user.update({
      where: { id: user.id },
      data: { cachedFeed: response }
    });
    console.log(`[Cache SET] Feed for user ${user.id} (${topPosts.length} posts)`);

    return res.json(response);
  } catch (error) {
    console.error('getFeed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/foryou/suggestions
 * Returns suggested subreddits based on user's persona
 */
async function getSuggestions(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    // Get user's Reddit subscriptions (synced from Reddit API)
    const userSubscriptions = await prisma.userSubscription.findMany({
      where: { userId: user.id },
      select: { subreddit: true }
    });
    const subscribedSubreddits = new Set(userSubscriptions.map(s => s.subreddit.toLowerCase()));
    console.log(`User ${user.id} has ${userSubscriptions.length} synced subscriptions. Checking for webdev:`, subscribedSubreddits.has('webdev'));

    // Get user's existing subreddit affinities from persona
    const persona = await prisma.userPersona.findUnique({
      where: { userId: user.id }
    });

    const existingAffinities = persona?.subredditAffinities || [];
    const affinitySubreddits = new Set(existingAffinities.map(a => a.name.toLowerCase()));

    // Get subreddits user marked as not interested (any count)
    const notInterestedSubreddits = await prisma.curatedPost.findMany({
      where: {
        userId: user.id,
        action: 'NOT_INTERESTED'
      },
      select: { subreddit: true },
      distinct: ['subreddit']
    });

    // Get actively blocked subreddits
    const explicitlyBlocked = await prisma.userBlockedSubreddit.findMany({
      where: { userId: user.id, isActive: true },
      select: { subreddit: true }
    });

    const blockedSubreddits = new Set([
      ...notInterestedSubreddits.map(p => p.subreddit.toLowerCase()),
      ...explicitlyBlocked.map(b => b.subreddit.toLowerCase())
    ]);

    // Get curated subreddits from categories
    const subreddits = await prisma.subreddit.findMany({
      include: { category: true },
      orderBy: { sortOrder: 'asc' }
    });

    // Filter out subscribed, affinities, and blocked - limit to 20
    const suggestions = subreddits
      .filter(s => !subscribedSubreddits.has(s.name.toLowerCase()))
      .filter(s => !affinitySubreddits.has(s.name.toLowerCase()))
      .filter(s => !blockedSubreddits.has(s.name.toLowerCase()))
      .slice(0, 20)
      .map(s => ({
        name: s.name,
        category: s.category.name
      }));

    res.json({ suggestions });
  } catch (error) {
    console.error('getSuggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
}

/**
 * GET /api/subreddit/:name/posts
 * Returns top posts from a subreddit via OAuth API
 */
async function getSubredditPosts(req, res) {
  try {
    const { name } = req.params;
    const { sort = 'hot' } = req.query;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Invalid subreddit name' });
    }

    // Sanitize subreddit name
    const subredditName = name.replace(/[^a-zA-Z0-9_]/g, '');

    if (!subredditName) {
      return res.status(400).json({ error: 'Invalid subreddit name' });
    }

    // Validate sort parameter
    const validSorts = ['hot', 'top', 'new'];
    const sortParam = validSorts.includes(sort) ? sort : 'hot';

    // Use OAuth API instead of RSS (Reddit blocks RSS from cloud IPs)
    const accessToken = await getAppOnlyAccessToken();

    // Fetch posts and subreddit info in parallel
    const postsUrl = sortParam === 'top'
      ? `https://oauth.reddit.com/r/${subredditName}/${sortParam}?limit=20&t=week`
      : `https://oauth.reddit.com/r/${subredditName}/${sortParam}?limit=20`;
    const aboutUrl = `https://oauth.reddit.com/r/${subredditName}/about`;

    const [postsResponse, aboutResponse] = await Promise.all([
      fetch(postsUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': USER_AGENT
        }
      }),
      fetch(aboutUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': USER_AGENT
        }
      })
    ]);

    if (!postsResponse.ok) {
      console.error(`OAuth fetch failed for r/${subredditName}: ${postsResponse.status}`);
      return res.status(502).json({ error: 'Failed to fetch from Reddit' });
    }

    const data = await postsResponse.json();
    const posts = data.data.children
      .filter(child => child.kind === 't3')
      .map(child => child.data)
      .filter(post => !post.over_18)
      .map(post => ({
        id: post.id,
        title: decodeHtmlEntities(post.title),
        subreddit: post.subreddit,
        link: `https://www.reddit.com${post.permalink}`,
        author: post.author,
        pubDate: new Date(post.created_utc * 1000).toISOString(),
        score: post.score,
        numComments: post.num_comments,
        thumbnail: post.thumbnail && !post.thumbnail.includes('self') ? post.thumbnail : null,
      }));

    // Extract related subreddits from description
    let relatedSubreddits = [];
    if (aboutResponse.ok) {
      const aboutData = await aboutResponse.json();
      const description = aboutData.data?.description || '';
      // Match r/subredditname patterns, excluding the current subreddit
      const matches = description.match(/r\/[a-zA-Z0-9_]+/g) || [];
      relatedSubreddits = [...new Set(matches)]
        .map(s => s.replace('r/', ''))
        .filter(s => s.toLowerCase() !== subredditName.toLowerCase())
        .slice(0, 10); // Limit to 10
    }

    res.json({
      subreddit: subredditName,
      posts,
      relatedSubreddits
    });
  } catch (error) {
    console.error('getSubredditPosts error:', error);
    res.status(500).json({ error: 'Failed to fetch subreddit posts' });
  }
}

/**
 * POST /api/foryou/subreddit-not-interested
 * Records that user is not interested in a subreddit
 */
async function subredditNotInterested(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const { subreddit } = req.body;
    if (!subreddit || typeof subreddit !== 'string') {
      return res.status(400).json({ error: 'Missing subreddit' });
    }

    // Create a placeholder curated post to record the NOT_INTERESTED action
    // This uses the same weighting system as post-level dismissals
    await prisma.curatedPost.create({
      data: {
        userId: user.id,
        redditPostId: `subreddit_dismiss_${subreddit}_${Date.now()}`,
        subreddit: subreddit,
        title: `[Subreddit Dismissed] r/${subreddit}`,
        action: 'NOT_INTERESTED'
      }
    });

    // Count total dismissals for this subreddit
    const count = await prisma.curatedPost.count({
      where: {
        userId: user.id,
        subreddit: subreddit,
        action: 'NOT_INTERESTED'
      }
    });

    console.log(`User ${user.redditUsername} dismissed r/${subreddit} (total: ${count})`);

    res.json({
      success: true,
      subreddit,
      dismissCount: count,
      blocked: count >= 5
    });
  } catch (error) {
    console.error('subredditNotInterested error:', error);
    res.status(500).json({ error: 'Failed to record dismissal' });
  }
}

/**
 * POST /api/foryou/subreddit/block
 * Block or unblock a subreddit (resets after 18h with new report)
 */
async function blockSubreddit(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const { subreddit, blocked } = req.body;
    if (!subreddit || typeof subreddit !== 'string') {
      return res.status(400).json({ error: 'Missing subreddit' });
    }

    // Check if record exists
    const existing = await prisma.userBlockedSubreddit.findUnique({
      where: {
        userId_subreddit: {
          userId: user.id,
          subreddit: subreddit
        }
      }
    });

    let record;
    if (blocked === false) {
      // Unblock: set isActive=false (keep record for count history)
      if (existing) {
        record = await prisma.userBlockedSubreddit.update({
          where: { id: existing.id },
          data: { isActive: false }
        });
      }
      console.log(`User ${user.id} unblocked r/${subreddit}`);
    } else {
      // Block: increment count and set isActive=true
      if (existing) {
        record = await prisma.userBlockedSubreddit.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            blockCount: existing.blockCount + 1
          }
        });
      } else {
        record = await prisma.userBlockedSubreddit.create({
          data: {
            userId: user.id,
            subreddit: subreddit,
            isActive: true,
            blockCount: 1
          }
        });
      }
      console.log(`User ${user.id} blocked r/${subreddit} (count: ${record.blockCount})`);
    }

    res.json({
      success: true,
      subreddit,
      blocked: blocked !== false,
      blockCount: record?.blockCount || 0
    });
  } catch (error) {
    console.error('blockSubreddit error:', error);
    res.status(500).json({ error: 'Failed to update blocked subreddit' });
  }
}

module.exports = {
  getPersona,
  getCurated,
  recordAction,
  getSettings,
  toggleStar,
  syncSubscriptions,
  refreshPersona,
  getFeed,
  generateReport,
  getReport,
  getSuggestions,
  getSubredditPosts,
  subredditNotInterested,
  blockSubreddit
};
