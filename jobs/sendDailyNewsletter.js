require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const emailService = require('../services/emailService');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function sendDailyNewsletter() {
  console.log('Starting Daily Newsletter Send...');

  // 1. Get today's published report
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const report = await prisma.dailyReport.findFirst({
    where: { status: 'PUBLISHED' },
    orderBy: { reportDate: 'desc' },
    include: {
      stories: {
        orderBy: { rank: 'asc' },
      },
    },
  });

  if (!report) {
    console.log('No published report found. Skipping newsletter.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found report: ${report.title} (${report.reportDate})`);

  // 2. Get active subscribers
  const subscribers = await prisma.subscription.findMany({
    where: { status: 'ACTIVE' },
  });

  console.log(`Found ${subscribers.length} active subscribers`);

  if (subscribers.length === 0) {
    console.log('No subscribers. Skipping newsletter.');
    await prisma.$disconnect();
    return;
  }

  // 3. Send newsletter
  const result = await emailService.sendDailyNewsletter(subscribers, report);

  console.log(`Newsletter complete: ${result.sent} sent, ${result.failed} failed`);

  await prisma.$disconnect();
}

if (require.main === module) {
  sendDailyNewsletter().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = sendDailyNewsletter;
