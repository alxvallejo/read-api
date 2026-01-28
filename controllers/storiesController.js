// controllers/storiesController.js
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

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

function serializeStory(s) {
  return {
    id: s.id,
    userId: s.userId,
    title: s.title,
    slug: s.slug,
    description: s.description,
    content: s.content,
    status: s.status,
    publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    _count: s._count || undefined
  };
}

// GET /api/stories
async function listStories(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const stories = await prisma.story.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { quotes: true } }
      }
    });

    return res.json({
      stories: stories.map(serializeStory),
      count: stories.length
    });
  } catch (error) {
    console.error('listStories error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/stories
async function createStory(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);

    const { title, description } = req.body;

    // Validate required fields
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    let slug = slugify(title);

    // Check for slug conflict (same user + slug)
    const existing = await prisma.story.findFirst({
      where: { userId: user.id, slug }
    });

    if (existing) {
      slug = slug + '-' + Date.now().toString(36);
    }

    const story = await prisma.story.create({
      data: {
        userId: user.id,
        title: title.trim(),
        slug,
        description: description?.trim() || null,
        content: {},
        status: 'DRAFT'
      },
      include: { _count: { select: { quotes: true } } }
    });

    return res.status(201).json({
      story: serializeStory(story)
    });
  } catch (error) {
    console.error('createStory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/stories/:id
async function getStory(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    const story = await prisma.story.findFirst({
      where: { id, userId: user.id },
      include: {
        _count: { select: { quotes: true } }
      }
    });

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    return res.json({
      story: serializeStory(story)
    });
  } catch (error) {
    console.error('getStory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PUT /api/stories/:id
async function updateStory(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    // Verify story belongs to user
    const existingStory = await prisma.story.findFirst({
      where: { id, userId: user.id }
    });

    if (!existingStory) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const { title, description, content } = req.body;

    const data = {};

    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'Title must be a non-empty string' });
      }
      data.title = title.trim();

      // If title changes and story is still DRAFT, re-generate slug
      if (data.title !== existingStory.title && existingStory.status === 'DRAFT') {
        let slug = slugify(data.title);

        const conflicting = await prisma.story.findFirst({
          where: { userId: user.id, slug, id: { not: id } }
        });

        if (conflicting) {
          slug = slug + '-' + Date.now().toString(36);
        }

        data.slug = slug;
      }
    }

    if (description !== undefined) {
      data.description = description?.trim() || null;
    }

    if (content !== undefined) {
      data.content = content;
    }

    const story = await prisma.story.update({
      where: { id },
      data,
      include: { _count: { select: { quotes: true } } }
    });

    return res.json({
      story: serializeStory(story)
    });
  } catch (error) {
    console.error('updateStory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/stories/:id
async function deleteStory(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    // Verify story belongs to user
    const existingStory = await prisma.story.findFirst({
      where: { id, userId: user.id }
    });

    if (!existingStory) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Unlink all quotes before deleting
    await prisma.quote.updateMany({
      where: { storyId: id },
      data: { storyId: null }
    });

    await prisma.story.delete({
      where: { id }
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('deleteStory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/stories/:id/publish
async function publishStory(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    // Verify story belongs to user
    const existingStory = await prisma.story.findFirst({
      where: { id, userId: user.id }
    });

    if (!existingStory) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = await prisma.story.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date()
      },
      include: { _count: { select: { quotes: true } } }
    });

    return res.json({
      story: serializeStory(story)
    });
  } catch (error) {
    console.error('publishStory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/stories/:id/unpublish
async function unpublishStory(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    // Verify story belongs to user
    const existingStory = await prisma.story.findFirst({
      where: { id, userId: user.id }
    });

    if (!existingStory) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = await prisma.story.update({
      where: { id },
      data: {
        status: 'DRAFT',
        publishedAt: null
      },
      include: { _count: { select: { quotes: true } } }
    });

    return res.json({
      story: serializeStory(story)
    });
  } catch (error) {
    console.error('unpublishStory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  listStories,
  createStory,
  getStory,
  updateStory,
  deleteStory,
  publishStory,
  unpublishStory
};
