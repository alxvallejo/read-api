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

      await prisma.engagementEvent.create({
        data: {
          anonymousId: anonymous_id,
          eventType: event_type,
          reportId: report_id,
          storyId: story_id,
          metadata
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
