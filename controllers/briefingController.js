const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * GET /api/briefing/latest
 * Returns the most recent published GlobalBriefing with stories
 */
async function getLatestBriefing(req, res) {
  try {
    const briefing = await prisma.globalBriefing.findFirst({
      where: { status: 'PUBLISHED' },
      orderBy: { briefingTime: 'desc' },
      include: {
        stories: {
          orderBy: { rank: 'asc' },
          include: {
            category: { select: { id: true, name: true, slug: true } }
          }
        }
      }
    });

    if (!briefing) {
      return res.status(404).json({ error: 'No briefing available' });
    }

    res.json(briefing);
  } catch (error) {
    console.error('Error fetching latest briefing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/briefing/:id
 * Returns a specific GlobalBriefing by ID with stories
 */
async function getBriefingById(req, res) {
  try {
    const { id } = req.params;
    
    const briefing = await prisma.globalBriefing.findUnique({
      where: { id: parseInt(id, 10) },
      include: {
        stories: {
          orderBy: { rank: 'asc' },
          include: {
            category: { select: { id: true, name: true, slug: true } }
          }
        }
      }
    });

    if (!briefing) {
      return res.status(404).json({ error: 'Briefing not found' });
    }

    res.json(briefing);
  } catch (error) {
    console.error('Error fetching briefing by ID:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/briefing/history
 * Returns paginated list of past briefings (metadata only)
 */
async function getBriefingHistory(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    const [briefings, total] = await Promise.all([
      prisma.globalBriefing.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: { briefingTime: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          title: true,
          briefingTime: true,
          publishedAt: true,
          executiveSummary: true,
          _count: { select: { stories: true } }
        }
      }),
      prisma.globalBriefing.count({ where: { status: 'PUBLISHED' } })
    ]);

    res.json({
      briefings,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + briefings.length < total
      }
    });
  } catch (error) {
    console.error('Error fetching briefing history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  getLatestBriefing,
  getBriefingById,
  getBriefingHistory,
};
