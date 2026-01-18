# For You API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement backend API endpoints for the For You personalized feed feature.

**Architecture:** User personas are built by analyzing saved posts with LLM. Feed combines user's subscribed subreddits + AI-recommended subreddits. Triage actions (save/read/not-interested) are tracked to refine recommendations. Reports are generated from curated posts.

**Tech Stack:** Node.js, Express, Prisma, PostgreSQL, OpenAI API

---

## API Contract (Frontend expects these)

```
GET  /api/foryou/persona           → { persona, lastRefreshedAt }
POST /api/foryou/persona/refresh   → { persona, lastRefreshedAt }
GET  /api/foryou/feed              → { posts[], recommendedSubreddits[] }
POST /api/foryou/action            → { success, curatedCount }
GET  /api/foryou/curated           → { posts[], count, limit }
GET  /api/foryou/settings          → { subreddits[], recommendedSubreddits[] }
POST /api/foryou/settings/star     → { success }
POST /api/foryou/report/generate   → { report }
```

---

## Task 1: Add Prisma Schema for For You Models

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Add UserPersona model**

Add after the User model:

```prisma
// ============ For You Feature ============

model UserPersona {
  id                  String    @id @default(uuid())
  userId              String    @unique @map("user_id")

  // LLM-generated persona
  keywords            Json      // string[] - interest keywords
  topics              Json      // string[] - topic areas
  subredditAffinities Json      @map("subreddit_affinities") // { name, weight }[]
  contentPreferences  Json      @map("content_preferences") // string[] - content types

  // Metadata
  analyzedPostCount   Int       @map("analyzed_post_count")
  llmModel            String?   @map("llm_model")

  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")

  user                User      @relation(fields: [userId], references: [id])

  @@map("user_personas")
}

model CuratedPost {
  id              String        @id @default(uuid())
  userId          String        @map("user_id")

  // Reddit post info
  redditPostId    String        @map("reddit_post_id")
  subreddit       String
  title           String
  url             String?
  thumbnail       String?
  score           Int           @default(0)
  numComments     Int           @default(0) @map("num_comments")
  author          String?
  createdUtc      DateTime?     @map("created_utc")
  isSelf          Boolean       @default(false) @map("is_self")

  // Triage
  action          TriageAction
  savedVia        SavedVia      @default(REDDZIT) @map("saved_via")

  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  user            User          @relation(fields: [userId], references: [id])

  @@unique([userId, redditPostId])
  @@index([userId, action])
  @@index([userId, createdAt(sort: Desc)])
  @@map("curated_posts")
}

enum TriageAction {
  SAVED
  ALREADY_READ
  NOT_INTERESTED
}

enum SavedVia {
  REDDZIT
  REDDIT
}

model UserSubredditStar {
  id          String    @id @default(uuid())
  userId      String    @map("user_id")
  subreddit   String
  starred     Boolean   @default(true)
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  user        User      @relation(fields: [userId], references: [id])

  @@unique([userId, subreddit])
  @@index([userId])
  @@map("user_subreddit_stars")
}

model ForYouReport {
  id              String        @id @default(uuid())
  userId          String        @map("user_id")
  status          ReportStatus  @default(DRAFT)

  // Generation params
  model           String        // gpt-4o-mini, gpt-4o, gpt-5.2
  postCount       Int           @map("post_count")

  // Output
  content         String?       // Generated report content (markdown)

  generatedAt     DateTime      @map("generated_at")
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  user            User          @relation(fields: [userId], references: [id])

  @@index([userId, createdAt(sort: Desc)])
  @@map("for_you_reports")
}
```

**Step 2: Update User model to add relations**

Add to the User model:

```prisma
model User {
  // ... existing fields ...

  persona           UserPersona?
  curatedPosts      CuratedPost[]
  subredditStars    UserSubredditStar[]
  forYouReports     ForYouReport[]

  // ... existing mappings ...
}
```

**Step 3: Run migration**

Run: `npx prisma migrate dev --name add_for_you_models`
Expected: Migration created and applied successfully

**Step 4: Generate Prisma client**

Run: `npx prisma generate`
Expected: Prisma Client generated

**Step 5: Commit**

```bash
git add prisma/
git commit -m "feat: add Prisma schema for For You feature"
```

---

## Task 2: Create forYouController.js with Basic Endpoints

**Files:**
- Create: `controllers/forYouController.js`

**Step 1: Create controller with Prisma setup and helper to get user**

```javascript
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
```

**Step 2: Verify no syntax errors**

Run: `node -c controllers/forYouController.js`
Expected: No errors

**Step 3: Commit**

```bash
git add controllers/forYouController.js
git commit -m "feat: add forYouController with basic endpoints"
```

---

## Task 3: Add Routes to server.js

**Files:**
- Modify: `server.js`

**Step 1: Import controller**

Add with other controller imports:

```javascript
const forYouController = require('./controllers/forYouController');
```

**Step 2: Add routes**

Add after existing API routes:

```javascript
// For You API
app.get('/api/foryou/persona', forYouController.getPersona);
app.get('/api/foryou/curated', forYouController.getCurated);
app.post('/api/foryou/action', forYouController.recordAction);
app.get('/api/foryou/settings', forYouController.getSettings);
app.post('/api/foryou/settings/star', forYouController.toggleStar);
```

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add For You routes to server.js"
```

---

## Task 4: Add Persona Refresh Endpoint with LLM Analysis

**Files:**
- Modify: `controllers/forYouController.js`

**Step 1: Add refreshPersona function**

Add this function to the controller:

```javascript
const llmService = require('../services/llmService');

// POST /api/foryou/persona/refresh
async function refreshPersona(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    // Fetch user's saved posts from Reddit
    const response = await fetch(
      `https://oauth.reddit.com/user/${user.redditUsername}/saved?limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch saved posts from Reddit');
    }

    const data = await response.json();
    const posts = data.data?.children || [];

    if (posts.length === 0) {
      return res.status(400).json({ error: 'No saved posts found to analyze' });
    }

    // Prepare posts for analysis
    const postsForAnalysis = posts
      .filter(p => p.kind === 't3') // Only posts, not comments
      .slice(0, 30) // Analyze up to 30 posts
      .map(p => ({
        subreddit: p.data.subreddit,
        title: p.data.title,
        selftext: p.data.selftext?.slice(0, 500) || '',
        score: p.data.score
      }));

    // Call LLM to analyze persona
    const personaPrompt = `Analyze these Reddit saved posts and create a user persona.

Posts:
${postsForAnalysis.map((p, i) => `${i + 1}. r/${p.subreddit}: "${p.title}" (score: ${p.score})`).join('\n')}

Return a JSON object with:
- keywords: array of 5-10 interest keywords (lowercase, single words)
- topics: array of 3-5 broad topic areas
- subredditAffinities: array of objects with { name: "subreddit", weight: 0.0-1.0 } for subreddits they'd likely enjoy (include some they haven't saved from yet)
- contentPreferences: array of content type preferences like "news", "discussions", "memes", "tutorials", "questions"

Return ONLY valid JSON, no markdown or explanation.`;

    const completion = await llmService.createCompletion({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a user interest analyzer. Return only valid JSON.' },
        { role: 'user', content: personaPrompt }
      ],
      temperature: 0.3
    });

    let personaData;
    try {
      const content = completion.choices[0].message.content;
      // Remove markdown code blocks if present
      const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      personaData = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('Failed to parse persona:', parseError);
      return res.status(500).json({ error: 'Failed to analyze persona' });
    }

    // Validate persona structure
    if (!personaData.keywords || !personaData.topics || !personaData.subredditAffinities || !personaData.contentPreferences) {
      return res.status(500).json({ error: 'Invalid persona structure from LLM' });
    }

    // Upsert persona
    const persona = await prisma.userPersona.upsert({
      where: { userId: user.id },
      update: {
        keywords: personaData.keywords,
        topics: personaData.topics,
        subredditAffinities: personaData.subredditAffinities,
        contentPreferences: personaData.contentPreferences,
        analyzedPostCount: postsForAnalysis.length,
        llmModel: 'gpt-4o-mini'
      },
      create: {
        userId: user.id,
        keywords: personaData.keywords,
        topics: personaData.topics,
        subredditAffinities: personaData.subredditAffinities,
        contentPreferences: personaData.contentPreferences,
        analyzedPostCount: postsForAnalysis.length,
        llmModel: 'gpt-4o-mini'
      }
    });

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
    console.error('refreshPersona error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

**Step 2: Export the function**

Update module.exports:

```javascript
module.exports = {
  getPersona,
  refreshPersona,
  getCurated,
  recordAction,
  getSettings,
  toggleStar
};
```

**Step 3: Add route to server.js**

```javascript
app.post('/api/foryou/persona/refresh', forYouController.refreshPersona);
```

**Step 4: Commit**

```bash
git add controllers/forYouController.js server.js
git commit -m "feat: add persona refresh with LLM analysis"
```

---

## Task 5: Add Feed Endpoint

**Files:**
- Modify: `controllers/forYouController.js`

**Step 1: Add getFeed function**

```javascript
const redditService = require('../services/redditService');

// GET /api/foryou/feed
async function getFeed(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const limit = parseInt(req.query.limit) || 20;
    const { user } = await getUserFromToken(token);

    // Get user's persona
    const persona = await prisma.userPersona.findUnique({
      where: { userId: user.id }
    });

    // Get starred subreddits (boosted priority)
    const stars = await prisma.userSubredditStar.findMany({
      where: { userId: user.id, starred: true }
    });
    const starredSubs = new Set(stars.map(s => s.subreddit));

    // Get already curated post IDs to exclude
    const curatedPosts = await prisma.curatedPost.findMany({
      where: { userId: user.id },
      select: { redditPostId: true }
    });
    const curatedIds = new Set(curatedPosts.map(p => p.redditPostId));

    // Build list of subreddits to fetch from
    let subreddits = [];

    // 1. Add starred subreddits first
    subreddits.push(...starredSubs);

    // 2. Add from persona affinities
    if (persona && Array.isArray(persona.subredditAffinities)) {
      const affinitySubs = persona.subredditAffinities
        .sort((a, b) => b.weight - a.weight)
        .map(a => a.name)
        .filter(s => !starredSubs.has(s));
      subreddits.push(...affinitySubs);
    }

    // 3. Fetch user's subscriptions from Reddit
    try {
      const subsResponse = await fetch(
        'https://oauth.reddit.com/subreddits/mine/subscriber?limit=50',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (subsResponse.ok) {
        const subsData = await subsResponse.json();
        const subscribedSubs = subsData.data?.children?.map(c => c.data.display_name) || [];
        subreddits.push(...subscribedSubs.filter(s => !subreddits.includes(s)));
      }
    } catch (e) {
      console.error('Failed to fetch subscriptions:', e);
    }

    // Deduplicate and limit
    subreddits = [...new Set(subreddits)].slice(0, 20);

    // Fetch posts from subreddits
    const allPosts = [];

    for (const subreddit of subreddits.slice(0, 10)) {
      try {
        const posts = await redditService.getTopPosts(subreddit, 10, prisma);
        allPosts.push(...posts.map(p => ({ ...p, sourceSubreddit: subreddit })));
      } catch (e) {
        console.error(`Failed to fetch from r/${subreddit}:`, e);
      }
    }

    // Filter out already curated posts
    const filteredPosts = allPosts.filter(p => !curatedIds.has(`t3_${p.id}`));

    // Sort by score and recency
    filteredPosts.sort((a, b) => {
      const aStarred = starredSubs.has(a.subreddit) ? 1 : 0;
      const bStarred = starredSubs.has(b.subreddit) ? 1 : 0;
      if (aStarred !== bStarred) return bStarred - aStarred;
      return b.score - a.score;
    });

    // Take top N
    const feedPosts = filteredPosts.slice(0, limit).map(p => ({
      id: p.id,
      redditPostId: `t3_${p.id}`,
      subreddit: p.subreddit,
      title: p.title,
      url: p.url,
      thumbnail: p.thumbnail && !p.thumbnail.includes('self') && !p.thumbnail.includes('default') ? p.thumbnail : null,
      score: p.score,
      numComments: p.num_comments,
      author: p.author,
      createdUtc: new Date(p.created_utc * 1000).toISOString(),
      isSelf: p.is_self
    }));

    // Get recommended subreddits from persona
    let recommendedSubreddits = [];
    if (persona && Array.isArray(persona.subredditAffinities)) {
      recommendedSubreddits = persona.subredditAffinities
        .filter(a => !subreddits.includes(a.name))
        .slice(0, 8)
        .map(a => a.name);
    }

    return res.json({
      posts: feedPosts,
      recommendedSubreddits
    });
  } catch (error) {
    console.error('getFeed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

**Step 2: Export and add route**

Add to exports:
```javascript
getFeed,
```

Add to server.js:
```javascript
app.get('/api/foryou/feed', forYouController.getFeed);
```

**Step 3: Commit**

```bash
git add controllers/forYouController.js server.js
git commit -m "feat: add For You feed endpoint"
```

---

## Task 6: Add Report Generation Endpoint

**Files:**
- Modify: `controllers/forYouController.js`

**Step 1: Add generateReport function**

```javascript
// POST /api/foryou/report/generate
async function generateReport(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { model } = req.body;
    const validModels = ['gpt-4o-mini', 'gpt-4o', 'gpt-5.2'];
    const selectedModel = validModels.includes(model) ? model : 'gpt-4o-mini';

    const { user } = await getUserFromToken(token);

    // Get saved curated posts
    const savedPosts = await prisma.curatedPost.findMany({
      where: {
        userId: user.id,
        action: 'SAVED'
      },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    if (savedPosts.length === 0) {
      return res.status(400).json({ error: 'No saved posts to generate report from' });
    }

    // Generate report with LLM
    const reportPrompt = `Create a personalized reading digest from these saved Reddit posts.

Posts:
${savedPosts.map((p, i) => `${i + 1}. r/${p.subreddit}: "${p.title}"\n   ${p.url || '(self post)'}`).join('\n\n')}

Create a well-formatted markdown report that:
1. Groups posts by theme/topic (not by subreddit)
2. Provides a brief summary for each group
3. Highlights the most interesting finds
4. Suggests what the reader might want to explore next

Make it engaging and personalized. Use markdown formatting.`;

    const completion = await llmService.createCompletion({
      model: selectedModel,
      messages: [
        { role: 'system', content: 'You are a personal curator creating reading digests. Write in a friendly, engaging tone.' },
        { role: 'user', content: reportPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    const reportContent = completion.choices[0].message.content;

    // Save report
    const report = await prisma.forYouReport.create({
      data: {
        userId: user.id,
        status: 'PUBLISHED',
        model: selectedModel,
        postCount: savedPosts.length,
        content: reportContent,
        generatedAt: new Date()
      }
    });

    // Clear saved posts after report generation (they've been processed)
    await prisma.curatedPost.updateMany({
      where: {
        userId: user.id,
        action: 'SAVED'
      },
      data: {
        action: 'ALREADY_READ'
      }
    });

    return res.json({
      report: {
        id: report.id,
        content: report.content,
        model: report.model,
        generatedAt: report.generatedAt.toISOString()
      }
    });
  } catch (error) {
    console.error('generateReport error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

**Step 2: Export and add route**

Add to exports:
```javascript
generateReport,
```

Add to server.js:
```javascript
app.post('/api/foryou/report/generate', forYouController.generateReport);
```

**Step 3: Commit**

```bash
git add controllers/forYouController.js server.js
git commit -m "feat: add report generation endpoint"
```

---

## Task 7: Final Integration & Testing

**Step 1: Verify all routes are registered**

Run: `grep -n "foryou" server.js`
Expected: All 7 routes listed

**Step 2: Start server and test health**

Run: `npm run dev`
Test: `curl http://localhost:3000/api/foryou/persona -H "Authorization: Bearer <token>"`
Expected: `{ "persona": null, "lastRefreshedAt": null }` for new users

**Step 3: Final commit**

```bash
git add .
git commit -m "chore: For You API complete"
```

---

## Summary

This plan implements the complete For You API:

| Endpoint | Description |
|----------|-------------|
| `GET /api/foryou/persona` | Get user's AI-built persona |
| `POST /api/foryou/persona/refresh` | Rebuild persona from saved posts |
| `GET /api/foryou/feed` | Get personalized feed |
| `POST /api/foryou/action` | Record triage action |
| `GET /api/foryou/curated` | Get curated posts |
| `GET /api/foryou/settings` | Get subreddit weights/stars |
| `POST /api/foryou/settings/star` | Star/unstar subreddit |
| `POST /api/foryou/report/generate` | Generate reading digest |

**Database models added:**
- `UserPersona` - LLM-generated user interests
- `CuratedPost` - Triage actions on posts
- `UserSubredditStar` - Boosted subreddits
- `ForYouReport` - Generated reports

**Next steps after backend:**
1. Test with frontend in worktree
2. Merge both branches to main
3. Deploy
