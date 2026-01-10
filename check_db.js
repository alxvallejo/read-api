require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function check() {
  const reports = await prisma.dailyReport.findMany();
  console.log(JSON.stringify(reports, null, 2));
}

check().catch(console.error).finally(() => prisma.$disconnect());
