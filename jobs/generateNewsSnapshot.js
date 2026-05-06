/**
 * Hourly snapshot job — pre-renders the /news feed JSON so nginx can serve
 * a cached homepage instantly without going through the Node app or hitting
 * Reddit on every visit.
 *
 * Output shape matches GET /api/trending/rss?subreddit=news so the frontend
 * can write it straight into its localStorage cache and TopFeed sees a hit.
 *
 * Output path: $SNAPSHOT_DIR/news.json (default: <read-api>/snapshots/)
 * The default sits next to the read-api process so it persists across frontend
 * deploys (which wipe reddzit-refresh/dist/). nginx aliases /snapshots/ to this dir.
 *
 * Run manually:  node jobs/generateNewsSnapshot.js
 * Scheduled:     hourly via the CronJob table (see prisma/seed-cron-jobs.js)
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const rssService = require('../services/rssService');

const SNAPSHOT_SUBREDDIT = 'news';
const DEFAULT_SNAPSHOT_DIR = path.resolve(__dirname, '..', 'snapshots');

function resolveSnapshotDir() {
  if (process.env.SNAPSHOT_DIR) {
    return path.resolve(process.env.SNAPSHOT_DIR);
  }
  return DEFAULT_SNAPSHOT_DIR;
}

async function generateNewsSnapshot() {
  const startedAt = Date.now();
  const snapshotDir = resolveSnapshotDir();
  const finalPath = path.join(snapshotDir, 'news.json');
  const tmpPath = `${finalPath}.tmp`;

  console.log(`[news-snapshot] writing to ${finalPath}`);

  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const feed = await rssService.getAggregatedFeed({
      subreddit: SNAPSHOT_SUBREDDIT,
      withTopComments: true,
      prisma,
    });

    if (!feed || !Array.isArray(feed.posts) || feed.posts.length === 0) {
      throw new Error('Aggregated feed returned no posts; refusing to overwrite snapshot');
    }

    fs.mkdirSync(snapshotDir, { recursive: true });

    const payload = {
      posts: feed.posts,
      generatedAt: feed.generatedAt || new Date().toISOString(),
      cached: true,
      source: 'news-snapshot-job',
    };

    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, finalPath);

    const ms = Date.now() - startedAt;
    console.log(`[news-snapshot] wrote ${feed.posts.length} posts in ${ms}ms`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  generateNewsSnapshot()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[news-snapshot] failed:', err);
      process.exit(1);
    });
}

module.exports = { generateNewsSnapshot };
