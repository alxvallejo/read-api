const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const emailService = require('../services/emailService');

// Initialize Prisma
// Note: In production, ensure this is singleton or handled correctly
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const dailyController = {
  async getLatestReport(req, res) {
    try {
      const today = new Date();
      today.setHours(0,0,0,0);
      
      // Find latest published report
      // If today's report is published, return it.
      // Else find most recent.
      
      const report = await prisma.dailyReport.findFirst({
        where: { status: 'PUBLISHED' },
        orderBy: { reportDate: 'desc' },
        include: {
          stories: {
            orderBy: { rank: 'asc' },
            include: {
              comments: {
                where: { isHighlighted: true }
              }
            }
          }
        }
      });

      if (!report) {
        return res.status(404).json({ error: 'No reports found' });
      }

      res.json(report);
    } catch (error) {
      console.error('getLatestReport error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Hourly Discover (random subreddits)
  async getLatestHourlyReport(req, res) {
    try {
      const report = await prisma.hourlyReport.findFirst({
        where: { status: 'PUBLISHED' },
        orderBy: { reportHour: 'desc' },
        include: {
          stories: {
            orderBy: { rank: 'asc' }
          }
        }
      });

      if (!report) {
        return res.status(404).json({ error: 'No hourly reports found' });
      }

      res.json(report);
    } catch (error) {
      console.error('getLatestHourlyReport error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Hourly Pulse (top posts from r/all with top comments)
  async getLatestHourlyPulseReport(req, res) {
    try {
      const report = await prisma.hourlyPulseReport.findFirst({
        where: { status: 'PUBLISHED' },
        orderBy: { reportHour: 'desc' },
        include: {
          stories: {
            orderBy: { rank: 'asc' }
          }
        }
      });

      if (!report) {
        return res.status(404).json({ error: 'No hourly pulse reports found' });
      }

      res.json(report);
    } catch (error) {
      console.error('getLatestHourlyPulseReport error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  async getHourlyPulseReportByHour(req, res) {
    try {
      const { hour } = req.params; // ISO timestamp
      const reportHour = new Date(hour);
      
      if (isNaN(reportHour.getTime())) {
        return res.status(400).json({ error: 'Invalid hour format' });
      }

      const report = await prisma.hourlyPulseReport.findUnique({
        where: { reportHour },
        include: {
          stories: {
            orderBy: { rank: 'asc' }
          }
        }
      });

      if (!report || report.status !== 'PUBLISHED') {
        return res.status(404).json({ error: 'Hourly pulse report not found' });
      }

      res.json(report);
    } catch (error) {
      console.error('getHourlyPulseReportByHour error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  async getHourlyReportByHour(req, res) {
    try {
      const { hour } = req.params; // ISO timestamp
      const reportHour = new Date(hour);
      
      if (isNaN(reportHour.getTime())) {
        return res.status(400).json({ error: 'Invalid hour format' });
      }

      const report = await prisma.hourlyReport.findUnique({
        where: { reportHour },
        include: {
          stories: {
            orderBy: { rank: 'asc' }
          }
        }
      });

      if (!report || report.status !== 'PUBLISHED') {
        return res.status(404).json({ error: 'Hourly report not found' });
      }

      res.json(report);
    } catch (error) {
      console.error('getHourlyReportByHour error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  async getReportByDate(req, res) {
    try {
      const { date } = req.params; // YYYY-MM-DD
      const reportDate = new Date(date);
      
      if (isNaN(reportDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
      }

      const report = await prisma.dailyReport.findUnique({
        where: { reportDate: reportDate },
        include: {
          stories: {
            orderBy: { rank: 'asc' },
            include: {
              comments: {
                where: { isHighlighted: true }
              }
            }
          }
        }
      });

      if (!report || report.status !== 'PUBLISHED') {
        return res.status(404).json({ error: 'Report not found' });
      }

      res.json(report);
    } catch (error) {
      console.error('getReportByDate error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  async subscribe(req, res) {
    try {
      const { email, topics, source } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      // Upsert subscription
      // Check if already subscribed
      const existing = await prisma.subscription.findUnique({ where: { email } });
      const isNewSubscription = !existing || existing.status !== 'ACTIVE';

      const sub = await prisma.subscription.upsert({
        where: { email },
        update: {
          status: 'ACTIVE',
          topics: topics || undefined,
          source: source || undefined,
        },
        create: {
          email,
          status: 'ACTIVE',
          topics,
          source: source || 'unknown'
        }
      });

      // Send welcome email for new subscriptions
      if (isNewSubscription) {
        try {
          await emailService.sendWelcomeEmail(email);
        } catch (emailError) {
          console.error('Failed to send welcome email:', emailError);
          // Don't fail the subscription if email fails
        }
      }

      res.json({ success: true, id: sub.id, isNew: isNewSubscription });
    } catch (error) {
      console.error('subscribe error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  async unsubscribe(req, res) {
    try {
      const { email, token } = req.query;
      
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      // Verify token matches (simple hash check)
      const expectedToken = Buffer.from(email).toString('base64').slice(0, 16);
      if (token !== expectedToken) {
        return res.status(400).json({ error: 'Invalid unsubscribe link' });
      }

      const sub = await prisma.subscription.findUnique({ where: { email } });
      
      if (!sub) {
        return res.status(404).json({ error: 'Subscription not found' });
      }

      await prisma.subscription.update({
        where: { email },
        data: { status: 'UNSUBSCRIBED' }
      });

      // Return HTML for browser visits
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Unsubscribed</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1>Successfully Unsubscribed</h1>
          <p>You've been removed from the Daily Reddit Pulse newsletter.</p>
          <p>We're sorry to see you go!</p>
        </body>
        </html>
      `);
    } catch (error) {
      console.error('unsubscribe error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  async trackEngagement(req, res) {
    try {
      const { anonymous_id, event_type, report_id, story_id, metadata } = req.body;
      
      if (!anonymous_id || !event_type) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Note: story_id FK only works with report_stories table (daily reports)
      // For hourly reports, we skip the FK by not including story_id if it's from hourly
      // For now, store story_id in metadata instead to avoid FK issues
      await prisma.engagementEvent.create({
        data: {
          anonymousId: anonymous_id,
          eventType: event_type,
          reportId: report_id || null,
          storyId: null, // Disabled due to FK constraint with hourly stories
          metadata: { ...metadata, originalStoryId: story_id }
        }
      });

      res.json({ success: true });
    } catch (error) {
      console.error('trackEngagement error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

module.exports = dailyController;
