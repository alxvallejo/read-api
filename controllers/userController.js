const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * POST /api/user/sync
 * Create or update a user record when they authenticate via Reddit OAuth
 * Body: { redditId, redditUsername }
 */
async function syncUser(req, res) {
  try {
    const { redditId, redditUsername } = req.body;

    if (!redditId || !redditUsername) {
      return res.status(400).json({ error: 'redditId and redditUsername required' });
    }

    // First check if user exists by username (for legacy users without redditId)
    let user = await prisma.user.findUnique({
      where: { redditUsername },
    });

    if (user) {
      // Update existing user with redditId if missing
      user = await prisma.user.update({
        where: { redditUsername },
        data: {
          redditId: user.redditId || redditId,
        },
      });
    } else {
      // Try to find by redditId or create new
      user = await prisma.user.upsert({
        where: { redditId },
        create: {
          redditId,
          redditUsername,
          isPro: false,
          isAdmin: false,
        },
        update: {
          redditUsername, // Update in case they changed username
        },
      });
    }

    res.json({
      id: user.id,
      redditId: user.redditId,
      redditUsername: user.redditUsername,
      isPro: user.isPro,
      proExpiresAt: user.proExpiresAt,
      isAdmin: user.isAdmin,
    });
  } catch (error) {
    console.error('Error syncing user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/user/:redditId
 * Get user info by Reddit ID (or username as fallback)
 */
async function getUser(req, res) {
  try {
    const { redditId } = req.params;

    // Try to find by redditId first, then fallback to username
    let user = await prisma.user.findUnique({
      where: { redditId },
      select: {
        id: true,
        redditId: true,
        redditUsername: true,
        isPro: true,
        proExpiresAt: true,
        isAdmin: true,
        createdAt: true,
      },
    });

    // Fallback to username lookup for legacy users
    if (!user) {
      user = await prisma.user.findUnique({
        where: { redditUsername: redditId },
        select: {
          id: true,
          redditId: true,
          redditUsername: true,
          isPro: true,
          proExpiresAt: true,
          isAdmin: true,
          createdAt: true,
        },
      });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if Pro has expired
    if (user.isPro && user.proExpiresAt && user.proExpiresAt < new Date()) {
      // Pro expired - update in background
      prisma.user.update({
        where: { id: user.id },
        data: { isPro: false }
      }).catch(console.error);

      user.isPro = false;
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/user/:redditId/subscription
 * Check subscription status for a user (by redditId or username)
 */
async function getSubscriptionStatus(req, res) {
  try {
    const { redditId } = req.params;

    // Try to find by redditId first, then fallback to username
    let user = await prisma.user.findUnique({
      where: { redditId },
      select: {
        isPro: true,
        proExpiresAt: true,
        stripeCustomerId: true,
      },
    });

    // Fallback to username lookup for legacy users
    if (!user) {
      user = await prisma.user.findUnique({
        where: { redditUsername: redditId },
        select: {
          isPro: true,
          proExpiresAt: true,
          stripeCustomerId: true,
        },
      });
    }

    if (!user) {
      return res.json({ isPro: false, hasAccount: false });
    }

    // Check expiration
    const isExpired = user.proExpiresAt && user.proExpiresAt < new Date();

    res.json({
      isPro: user.isPro && !isExpired,
      proExpiresAt: user.proExpiresAt,
      hasStripe: !!user.stripeCustomerId,
      hasAccount: true,
    });
  } catch (error) {
    console.error('Error checking subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  syncUser,
  getUser,
  getSubscriptionStatus,
};
