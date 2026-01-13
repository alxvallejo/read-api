/**
 * Seed script to initialize cron job configuration in the database.
 * Run once with: node prisma/seed-cron-jobs.js
 */
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const cronJobs = [
  {
    name: 'global-briefing',
    displayName: 'Global Briefing',
    description: 'Generates briefing from top posts across all categories every 6 hours',
    script: 'jobs/generateGlobalBriefing.js',
    cronExpression: '0 0,6,12,18 * * *',
    enabled: true,
  },
  {
    name: 'hourly-pulse',
    displayName: 'Hourly Pulse',
    description: 'Top posts from r/all with top comments, hourly from 6am-11pm UTC',
    script: 'jobs/generateHourlyPulseReport.js',
    cronExpression: '0 6-23 * * *',
    enabled: true,
  },
  {
    name: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily summary report at 11:00 UTC',
    script: 'jobs/generateDailyReport.js',
    cronExpression: '0 11 * * *',
    enabled: false,
  },
];

async function seed() {
  console.log('Seeding cron jobs...');

  for (const job of cronJobs) {
    const existing = await prisma.cronJob.findUnique({
      where: { name: job.name },
    });

    if (existing) {
      console.log(`  - ${job.name}: already exists, skipping`);
    } else {
      await prisma.cronJob.create({ data: job });
      console.log(`  - ${job.name}: created`);
    }
  }

  console.log('Done!');
}

seed()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
