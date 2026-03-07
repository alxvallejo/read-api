// controllers/linksController.js
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
    user = await prisma.user.update({
      where: { id: user.id },
      data: { redditId: redditUser.id }
    });
  }

  return { user, redditUser };
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice(7);
}

function formatLink(link) {
  return {
    id: link.id,
    url: link.url,
    title: link.title,
    description: link.description,
    favicon: link.favicon,
    tags: link.tags,
    note: link.note,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString()
  };
}

// GET /api/links
async function listLinks(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const links = await prisma.savedLink.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({
      links: links.map(formatLink),
      count: links.length
    });
  } catch (error) {
    console.error('listLinks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/links
async function createLink(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { url, title, description, favicon } = req.body;

    if (!url || !title) {
      return res.status(400).json({ error: 'Missing required fields: url, title' });
    }

    // Check for duplicate
    const existing = await prisma.savedLink.findUnique({
      where: { userId_url: { userId: user.id, url } }
    });

    if (existing) {
      return res.status(409).json({ error: 'Link already saved', link: formatLink(existing) });
    }

    const link = await prisma.savedLink.create({
      data: {
        userId: user.id,
        url,
        title,
        description: description || null,
        favicon: favicon || null
      }
    });

    return res.status(201).json({ link: formatLink(link) });
  } catch (error) {
    console.error('createLink error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PUT /api/links/:id
async function updateLink(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    const existing = await prisma.savedLink.findFirst({
      where: { id, userId: user.id }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Link not found' });
    }

    const { note, tags } = req.body;

    const link = await prisma.savedLink.update({
      where: { id },
      data: {
        note: note !== undefined ? note : existing.note,
        tags: tags !== undefined ? tags : existing.tags
      }
    });

    return res.json({ link: formatLink(link) });
  } catch (error) {
    console.error('updateLink error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/links/:id
async function deleteLink(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    const existing = await prisma.savedLink.findFirst({
      where: { id, userId: user.id }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Link not found' });
    }

    await prisma.savedLink.delete({ where: { id } });

    return res.json({ success: true });
  } catch (error) {
    console.error('deleteLink error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  listLinks,
  createLink,
  updateLink,
  deleteLink
};
