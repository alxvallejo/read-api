// controllers/linksController.js
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const read = require('./readController');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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

function parseDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Detect Cloudflare challenges, CAPTCHAs, and other bot-blocking pages
const JUNK_PATTERNS = [
  /attention required/i,
  /cloudflare/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /ray id/i,
  /just a moment/i,
  /access denied/i,
  /please verify you are a human/i,
  /captcha/i,
  /blocked/i,
  /security check/i,
];

function isJunkContent(title, content) {
  const text = `${title || ''} ${content || ''}`;
  // If content is very short and matches a pattern, it's junk
  const stripped = (content || '').replace(/<[^>]*>/g, '').trim();
  if (stripped.length < 200) {
    return JUNK_PATTERNS.some(p => p.test(text));
  }
  // Even long content: if the title itself is a bot-block phrase, reject
  if (title && JUNK_PATTERNS.some(p => p.test(title))) {
    return true;
  }
  return false;
}

function mapLink(link) {
  return {
    id: link.id,
    url: link.url,
    title: link.title,
    imageUrl: link.imageUrl,
    domain: link.domain,
    hasContent: !!link.extractedContent,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString()
  };
}

// POST /api/links
async function saveLink(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { url, title: clientTitle, imageUrl: clientImageUrl, description: clientDescription } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const domain = parseDomain(url);

    // Check for duplicate
    const existing = await prisma.savedLink.findUnique({
      where: { userId_url: { userId: user.id, url } }
    });
    if (existing) {
      return res.status(409).json({ error: 'Link already saved', link: mapLink(existing) });
    }

    let title = clientTitle || null;
    let extractedContent = clientDescription || null;
    let imageUrl = clientImageUrl || null;

    // Skip server-side extraction when client provided an image URL
    // (likely a JS-rendered page like Instagram that would fail anyway)
    if (!clientImageUrl) {
      try {
        const extracted = await read.readUrl(url, token);
        if (extracted && !isJunkContent(extracted.title, extracted.content)) {
          title = extracted.title || title;
          extractedContent = extracted.content || extractedContent;
        } else if (extracted) {
          console.warn('Junk content detected for', url, '— title:', extracted.title);
        }
      } catch (err) {
        console.warn('Link content extraction failed for', url, err?.message);
        // Save anyway — user can still open the original link
      }
    }

    const link = await prisma.savedLink.create({
      data: {
        userId: user.id,
        url,
        title,
        imageUrl,
        domain,
        extractedContent,
      }
    });

    return res.status(201).json({ link: mapLink(link) });
  } catch (error) {
    console.error('saveLink error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        url: true,
        title: true,
        imageUrl: true,
        domain: true,
        extractedContent: false,
        createdAt: true,
        updatedAt: true,
      }
    });

    return res.json({
      links: links.map(l => ({
        id: l.id,
        url: l.url,
        title: l.title,
        imageUrl: l.imageUrl,
        domain: l.domain,
        hasContent: false,
        createdAt: l.createdAt.toISOString(),
        updatedAt: l.updatedAt.toISOString()
      })),
      count: links.length
    });
  } catch (error) {
    console.error('listLinks error:', error);
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

// GET /api/links/:id/content
async function getLinkContent(req, res) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { user } = await getUserFromToken(token);
    const { id } = req.params;

    const link = await prisma.savedLink.findFirst({
      where: { id, userId: user.id }
    });

    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // If we have cached content, check it's not junk before returning
    if (link.extractedContent) {
      if (isJunkContent(link.title, link.extractedContent)) {
        // Clear the junk so we don't keep serving it
        await prisma.savedLink.update({
          where: { id },
          data: { extractedContent: null, title: null }
        });
      } else {
        return res.json({
          link: mapLink(link),
          content: {
            type: 'article',
            title: link.title,
            content: link.extractedContent
          }
        });
      }
    }

    // Try to re-extract
    try {
      const extracted = await read.readUrl(link.url, token);
      if (extracted && extracted.content) {
        await prisma.savedLink.update({
          where: { id },
          data: {
            title: extracted.title || link.title,
            extractedContent: extracted.content
          }
        });

        return res.json({
          link: { ...mapLink(link), title: extracted.title || link.title, hasContent: true },
          content: {
            type: 'article',
            title: extracted.title || link.title,
            content: extracted.content
          }
        });
      }
    } catch (err) {
      console.warn('Re-extraction failed for', link.url, err?.message);
    }

    // Extraction failed — return link data without content so frontend can redirect
    return res.json({
      link: mapLink(link),
      content: null
    });
  } catch (error) {
    console.error('getLinkContent error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  saveLink,
  listLinks,
  deleteLink,
  getLinkContent
};
