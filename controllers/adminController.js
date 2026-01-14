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
 * POST /api/admin/users/:redditUsername/pro
 * Toggle Pro status for a user
 * Body: { isPro: boolean, expiresInDays?: number }
 */
async function setUserPro(req, res) {
  try {
    const { redditUsername } = req.params;
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
      where: { redditUsername },
      data: updateData,
    });

    res.json({
      success: true,
      user: {
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
 * POST /api/admin/users/:redditUsername/admin
 * Toggle Admin status for a user
 * Body: { isAdmin: boolean }
 */
async function setUserAdmin(req, res) {
  try {
    const { redditUsername } = req.params;
    const { isAdmin } = req.body;

    const user = await prisma.user.update({
      where: { redditUsername },
      data: { isAdmin: !!isAdmin },
    });

    res.json({
      success: true,
      user: {
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
        orderBy: { periodStart: 'desc' },
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

// ============ Cron Job Management ============

const pm2Service = require('../services/pm2Service');

/**
 * GET /api/admin/jobs
 * List all cron jobs with their current status
 */
async function listJobs(req, res) {
  try {
    // Get job configs from database
    const jobs = await prisma.cronJob.findMany({
      orderBy: { name: 'asc' },
      include: {
        runHistory: {
          take: 5,
          orderBy: { startedAt: 'desc' },
        },
      },
    });

    // Get PM2 process status
    let pm2Status = [];
    try {
      pm2Status = await pm2Service.getProcessList();
    } catch (e) {
      console.error('Failed to get PM2 status:', e.message);
    }

    // Merge database config with PM2 runtime status
    const enrichedJobs = jobs.map(job => {
      const pm2Process = pm2Status.find(p => p.name === job.name);
      return {
        ...job,
        runtime: pm2Process ? {
          status: pm2Process.status,
          pid: pm2Process.pid,
          memory: pm2Process.memory,
          uptime: pm2Process.uptime,
          restarts: pm2Process.restarts,
        } : null,
      };
    });

    res.json({ jobs: enrichedJobs });
  } catch (error) {
    console.error('Error listing jobs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/admin/jobs/:name
 * Update job configuration (enable/disable, cron expression)
 * Body: { enabled?: boolean, cronExpression?: string }
 */
async function updateJob(req, res) {
  try {
    const { name } = req.params;
    const { enabled, cronExpression } = req.body;

    // Validate cron expression if provided
    if (cronExpression !== undefined) {
      if (!isValidCronExpression(cronExpression)) {
        return res.status(400).json({ error: 'Invalid cron expression' });
      }
    }

    // Update database
    const job = await prisma.cronJob.update({
      where: { name },
      data: {
        ...(enabled !== undefined && { enabled }),
        ...(cronExpression !== undefined && { cronExpression }),
      },
    });

    // Apply changes to PM2
    await pm2Service.applyJobConfig({
      name: job.name,
      script: job.script,
      cronExpression: job.cronExpression,
      enabled: job.enabled,
    });

    res.json({ success: true, job });
  } catch (error) {
    console.error('Error updating job:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/jobs/:name/trigger
 * Manually trigger a job to run immediately
 */
async function triggerJob(req, res) {
  try {
    const { name } = req.params;
    const username = req.headers['x-reddit-username'] || 'admin';

    const job = await prisma.cronJob.findUnique({ where: { name } });
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Create run record
    const run = await prisma.cronJobRun.create({
      data: {
        jobId: job.id,
        startedAt: new Date(),
        status: 'RUNNING',
        triggeredBy: `manual:${username}`,
      },
    });

    // Trigger job asynchronously - don't wait for completion
    pm2Service.triggerJob(job.name, job.script)
      .then(async (result) => {
        await prisma.cronJobRun.update({
          where: { id: run.id },
          data: {
            completedAt: new Date(),
            status: result.success ? 'COMPLETED' : 'FAILED',
            output: result.output,
          },
        });

        await prisma.cronJob.update({
          where: { name },
          data: {
            lastRunAt: new Date(),
            lastRunStatus: result.success ? 'COMPLETED' : 'FAILED',
            lastRunDuration: result.duration,
          },
        });
      })
      .catch(async (error) => {
        await prisma.cronJobRun.update({
          where: { id: run.id },
          data: {
            completedAt: new Date(),
            status: 'FAILED',
            output: error.message,
          },
        });
      });

    res.json({
      success: true,
      message: 'Job triggered',
      runId: run.id,
    });
  } catch (error) {
    console.error('Error triggering job:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/admin/jobs/:name/runs
 * Get run history for a job
 */
async function getJobRuns(req, res) {
  try {
    const { name } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const job = await prisma.cronJob.findUnique({ where: { name } });
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const runs = await prisma.cronJobRun.findMany({
      where: { jobId: job.id },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });

    res.json({ runs });
  } catch (error) {
    console.error('Error fetching job runs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Basic cron expression validator
 * Validates that cron has 5 fields with valid characters
 */
function isValidCronExpression(expr) {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && parts.every(part => /^[\d,\-\*\/]+$/.test(part));
}

// ============ Reddit API Usage ============

/**
 * GET /api/admin/reddit-usage
 * Get Reddit API usage statistics
 */
async function getRedditUsage(req, res) {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [lastHour, last24Hours, apiStatus] = await Promise.all([
      prisma.redditApiLog.count({
        where: { createdAt: { gte: oneHourAgo } }
      }),
      prisma.redditApiLog.count({
        where: { createdAt: { gte: oneDayAgo } }
      }),
      prisma.apiStatus.findUnique({ where: { id: 'reddit' } }),
    ]);

    const limit = 60; // Reddit's rate limit per hour
    const remaining = Math.max(0, limit - lastHour);

    res.json({
      lastHour,
      last24Hours,
      limit,
      remaining,
      percentUsed: Math.round((lastHour / limit) * 100),
      apiStatus: apiStatus ? {
        isHealthy: apiStatus.isHealthy,
        lastCheckedAt: apiStatus.lastCheckedAt,
        lastErrorCode: apiStatus.lastErrorCode,
        failureCount: apiStatus.failureCount,
      } : null,
    });
  } catch (error) {
    console.error('Error fetching Reddit usage:', error);
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
  // Cron Job Management
  listJobs,
  updateJob,
  triggerJob,
  getJobRuns,
  // Reddit API Usage
  getRedditUsage,
};
