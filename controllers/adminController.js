const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Admin usernames that can access admin endpoints (from env)
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || 'no_spoon').split(',').map(u => u.trim().toLowerCase());

/**
 * Middleware to verify admin access
 * Checks for either:
 * 1. X-Admin-Password header matching ADMIN_PASSWORD env var
 * 2. X-Reddit-Username header matching an admin username
 */
function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const headerPassword = req.headers['x-admin-password'];
  const headerUsername = req.headers['x-reddit-username']?.toLowerCase();

  // Check password auth
  if (adminPassword && headerPassword === adminPassword) {
    return next();
  }

  // Check username auth
  if (headerUsername && ADMIN_USERNAMES.includes(headerUsername)) {
    return next();
  }

  return res.status(403).json({ error: 'Admin access required' });
}

/**
 * GET /api/admin/stats
 * Dashboard statistics
 */
async function getStats(req, res) {
  try {
    const [
      totalUsers,
      proUsers,
      totalBriefings,
      totalDiscoverReports,
      recentUsers,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isPro: true } }),
      prisma.globalBriefing.count({ where: { status: 'PUBLISHED' } }),
      prisma.discoverReport.count(),
      prisma.user.count({
        where: {
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }
      }),
    ]);

    res.json({
      users: {
        total: totalUsers,
        pro: proUsers,
        free: totalUsers - proUsers,
        newThisWeek: recentUsers,
      },
      content: {
        globalBriefings: totalBriefings,
        discoverReports: totalDiscoverReports,
      },
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/admin/users
 * List all users with pagination
 */
async function listUsers(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = req.query.search || '';

    const where = search
      ? { redditUsername: { contains: search, mode: 'insensitive' } }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          redditId: true,
          redditUsername: true,
          isPro: true,
          proExpiresAt: true,
          isAdmin: true,
          createdAt: true,
          lastLoginAt: true,
          _count: {
            select: {
              categorySelections: true,
              subredditToggles: true,
              discoverReports: true,
            }
          }
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      users,
      pagination: { total, limit, offset, hasMore: offset + users.length < total },
    });
  } catch (error) {
    console.error('Error listing users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/users/:redditId/pro
 * Toggle Pro status for a user
 * Body: { isPro: boolean, expiresInDays?: number }
 */
async function setUserPro(req, res) {
  try {
    const { redditId } = req.params;
    const { isPro, expiresInDays } = req.body;

    const updateData = { isPro: !!isPro };
    
    if (isPro && expiresInDays) {
      updateData.proExpiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    } else if (isPro) {
      // Default to 1 year if no expiry specified
      updateData.proExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    } else {
      updateData.proExpiresAt = null;
    }

    const user = await prisma.user.update({
      where: { redditId },
      data: updateData,
    });

    res.json({
      success: true,
      user: {
        redditId: user.redditId,
        redditUsername: user.redditUsername,
        isPro: user.isPro,
        proExpiresAt: user.proExpiresAt,
      },
    });
  } catch (error) {
    console.error('Error setting user pro status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/users/:redditId/admin
 * Toggle Admin status for a user
 * Body: { isAdmin: boolean }
 */
async function setUserAdmin(req, res) {
  try {
    const { redditId } = req.params;
    const { isAdmin } = req.body;

    const user = await prisma.user.update({
      where: { redditId },
      data: { isAdmin: !!isAdmin },
    });

    res.json({
      success: true,
      user: {
        redditId: user.redditId,
        redditUsername: user.redditUsername,
        isAdmin: user.isAdmin,
      },
    });
  } catch (error) {
    console.error('Error setting user admin status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/admin/briefings
 * List all briefings with status
 */
async function listBriefings(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    const [briefings, total] = await Promise.all([
      prisma.globalBriefing.findMany({
        orderBy: { briefingTime: 'desc' },
        skip: offset,
        take: limit,
        include: {
          _count: { select: { stories: true } }
        }
      }),
      prisma.globalBriefing.count(),
    ]);

    res.json({
      briefings,
      pagination: { total, limit, offset, hasMore: offset + briefings.length < total },
    });
  } catch (error) {
    console.error('Error listing briefings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/briefings/:id/regenerate
 * Force regenerate a briefing
 */
async function regenerateBriefing(req, res) {
  try {
    const { id } = req.params;
    
    // Set status to DRAFT to allow regeneration
    await prisma.globalBriefing.update({
      where: { id: parseInt(id, 10) },
      data: { status: 'DRAFT' }
    });

    // Trigger regeneration (the job will pick up DRAFT status)
    const generateGlobalBriefing = require('../jobs/generateGlobalBriefing');
    
    // Run async, don't wait
    generateGlobalBriefing(true).catch(console.error);

    res.json({ success: true, message: 'Briefing regeneration started' });
  } catch (error) {
    console.error('Error regenerating briefing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/admin/briefings/:id
 * Delete a briefing
 */
async function deleteBriefing(req, res) {
  try {
    const { id } = req.params;
    const briefingId = parseInt(id, 10);

    // Delete stories first (cascade)
    await prisma.globalBriefingStory.deleteMany({
      where: { briefingId }
    });

    await prisma.globalBriefing.delete({
      where: { id: briefingId }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting briefing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  requireAdmin,
  getStats,
  listUsers,
  setUserPro,
  setUserAdmin,
  listBriefings,
  regenerateBriefing,
  deleteBriefing,
};
