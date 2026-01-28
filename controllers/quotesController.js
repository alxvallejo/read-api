// controllers/quotesController.js
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Helper to get user from token (via Reddit API)
const USER_AGENT = process.env.USER_AGENT || 'Reddzit/1.0';

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

// GET /api/quotes
async function listQuotes(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const quotes = await prisma.quote.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({
      quotes: quotes.map(q => ({
        id: q.id,
        postId: q.postId,
        text: q.text,
        sourceUrl: q.sourceUrl,
        subreddit: q.subreddit,
        postTitle: q.postTitle,
        author: q.author,
        note: q.note,
        tags: q.tags,
        createdAt: q.createdAt.toISOString(),
        updatedAt: q.updatedAt.toISOString()
      })),
      count: quotes.length
    });
  } catch (error) {
    console.error('listQuotes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/quotes
async function createQuote(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const { postId, text, sourceUrl, subreddit, postTitle, author, note, tags } = req.body;

    // Validate required fields
    if (!postId || !text || !sourceUrl || !subreddit || !postTitle || !author) {
      return res.status(400).json({
        error: 'Missing required fields: postId, text, sourceUrl, subreddit, postTitle, author'
      });
    }

    const quote = await prisma.quote.create({
      data: {
        userId: user.id,
        postId,
        text,
        sourceUrl,
        subreddit,
        postTitle,
        author,
        note: note || null,
        tags: tags || []
      }
    });

    return res.status(201).json({
      quote: {
        id: quote.id,
        postId: quote.postId,
        text: quote.text,
        sourceUrl: quote.sourceUrl,
        subreddit: quote.subreddit,
        postTitle: quote.postTitle,
        author: quote.author,
        note: quote.note,
        tags: quote.tags,
        createdAt: quote.createdAt.toISOString(),
        updatedAt: quote.updatedAt.toISOString()
      }
    });
  } catch (error) {
    console.error('createQuote error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PUT /api/quotes/:id
async function updateQuote(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    // Verify quote belongs to user
    const existingQuote = await prisma.quote.findFirst({
      where: {
        id,
        userId: user.id
      }
    });

    if (!existingQuote) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    const { note, tags } = req.body;

    // Only allow updating note and tags
    const quote = await prisma.quote.update({
      where: { id },
      data: {
        note: note !== undefined ? note : existingQuote.note,
        tags: tags !== undefined ? tags : existingQuote.tags
      }
    });

    return res.json({
      quote: {
        id: quote.id,
        postId: quote.postId,
        text: quote.text,
        sourceUrl: quote.sourceUrl,
        subreddit: quote.subreddit,
        postTitle: quote.postTitle,
        author: quote.author,
        note: quote.note,
        tags: quote.tags,
        createdAt: quote.createdAt.toISOString(),
        updatedAt: quote.updatedAt.toISOString()
      }
    });
  } catch (error) {
    console.error('updateQuote error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/quotes/:id
async function deleteQuote(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    // Verify quote belongs to user
    const existingQuote = await prisma.quote.findFirst({
      where: {
        id,
        userId: user.id
      }
    });

    if (!existingQuote) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    await prisma.quote.delete({
      where: { id }
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('deleteQuote error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  listQuotes,
  createQuote,
  updateQuote,
  deleteQuote
};
