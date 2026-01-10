const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

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
      const sub = await prisma.subscription.upsert({
        where: { email },
        update: {
          status: 'ACTIVE', // Or pending if double opt-in
          topics: topics || undefined,
          source: source || undefined,
          updatedAt: new Date() // Schema doesn't have updatedAt but useful
        },
        create: {
          email,
          status: 'ACTIVE',
          topics,
          source: source || 'unknown'
        }
      });

      res.json({ success: true, id: sub.id });
    } catch (error) {
      console.error('subscribe error:', error);
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
