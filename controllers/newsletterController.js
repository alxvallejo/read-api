const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * GET /api/newsletter/latest
 * Returns the most recent published newsletter with stories
 */
async function getLatestNewsletter(req, res) {
  try {
    const issue = await prisma.newsletterIssue.findFirst({
      where: { status: 'PUBLISHED' },
      orderBy: { issueDate: 'desc' },
      include: {
        stories: { orderBy: { rank: 'asc' } },
      },
    });

    if (!issue) {
      return res.status(404).json({ error: 'No newsletter available' });
    }

    res.json(issue);
  } catch (error) {
    console.error('Error fetching latest newsletter:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/newsletter/:id
 * Returns a specific newsletter by ID with stories
 */
async function getNewsletterById(req, res) {
  try {
    const { id } = req.params;

    const issue = await prisma.newsletterIssue.findUnique({
      where: { id },
      include: {
        stories: { orderBy: { rank: 'asc' } },
      },
    });

    if (!issue) {
      return res.status(404).json({ error: 'Newsletter not found' });
    }

    res.json(issue);
  } catch (error) {
    console.error('Error fetching newsletter by ID:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/newsletter/history
 * Returns paginated list of past newsletters (metadata only)
 */
async function getNewsletterHistory(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    const [issues, total] = await Promise.all([
      prisma.newsletterIssue.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: { issueDate: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          title: true,
          issueDate: true,
          publishedAt: true,
          executiveSummary: true,
          sourceBreakdown: true,
          recipientCount: true,
          _count: { select: { stories: true } },
        },
      }),
      prisma.newsletterIssue.count({ where: { status: 'PUBLISHED' } }),
    ]);

    res.json({
      issues,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + issues.length < total,
      },
    });
  } catch (error) {
    console.error('Error fetching newsletter history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  getLatestNewsletter,
  getNewsletterById,
  getNewsletterHistory,
};
