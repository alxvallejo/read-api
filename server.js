require('dotenv').config();
const read = require('./controllers/readController.js');
const redditProxy = require('./controllers/redditProxyController.js');
const redditService = require('./services/redditService.js');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const https = require('https');
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const app = express();
const port = process.env.PORT || 3000;
const nodeFetch = require('node-fetch');

// Prisma client for API status tracking
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Frontend SSR integration for dynamic share previews
const FRONTEND_DIST_DIR = process.env.FRONTEND_DIST_DIR || null; // e.g. /var/www/reddzit-refresh/dist
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
let INDEX_HTML_CACHE = null;
let INDEX_HTML_MTIME = null;

async function readIndexHtml() {
  if (!FRONTEND_DIST_DIR) return null;
  const indexPath = path.join(FRONTEND_DIST_DIR, 'index.html');
  try {
    const stat = fs.statSync(indexPath);
    const mtime = stat.mtimeMs;
    if (!INDEX_HTML_CACHE || INDEX_HTML_MTIME !== mtime) {
      INDEX_HTML_CACHE = fs.readFileSync(indexPath, 'utf8');
      INDEX_HTML_MTIME = mtime;
    }
    return INDEX_HTML_CACHE;
  } catch (e) {
    console.warn('SSR: index.html not found at', indexPath);
    return null;
  }
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function pickPreviewImage(post) {
  try {
    const preview = post && post.preview && post.preview.images && post.preview.images[0];
    if (preview && preview.source && preview.source.url) {
      return preview.source.url.replace(/&amp;/g, '&');
    }
  } catch (_) {}
  const thumb = post && post.thumbnail;
  if (thumb && /^https?:\/\//.test(thumb)) return thumb;
  return PUBLIC_BASE_URL ? PUBLIC_BASE_URL + '/favicon.png' : '/favicon.png';
}

async function fetchRedditPublic(fullname) {
  // Check if API is currently restricted before making a call
  const isRestricted = await redditService.isApiRestricted(prisma);
  if (isRestricted) {
    console.log('Reddit API restricted, skipping fetch for:', fullname);
    return null;
  }

  // Use app-only OAuth since Reddit blocks unauthenticated .json endpoints
  const accessToken = await redditProxy.getAppOnlyAccessToken();
  const endpoint = `https://oauth.reddit.com/by_id/${encodeURIComponent(fullname)}`;
  const r = await nodeFetch(endpoint, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': process.env.USER_AGENT || 'Reddzit/1.0'
    }
  });

  // Track API status based on response
  if (!r.ok) {
    const isRestrictedError = redditService.RESTRICTED_ERROR_CODES.includes(r.status);
    if (isRestrictedError) {
      console.error(`Reddit API restricted (${r.status}): ${r.statusText}`);
      await redditService.recordApiStatus(prisma, false, r.status, r.statusText);
    }
    throw new Error('Reddit fetch failed: ' + r.status);
  }

  // Record successful API call
  await redditService.recordApiStatus(prisma, true);

  const json = await r.json();
  const post = json && json.data && json.data.children && json.data.children[0] && json.data.children[0].data;
  return post || null;
}

function injectMeta(html, meta) {
  const headOpen = html.indexOf('<head>');
  if (headOpen === -1) return html;
  const before = html.slice(0, headOpen + '<head>'.length);
  const after = html.slice(headOpen + '<head>'.length);
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta property="og:title" content="${escapeHtml(meta.ogTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.ogDescription)}">`,
    `<meta property="og:image" content="${escapeHtml(meta.ogImage)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.ogUrl)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.ogTitle)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.ogDescription)}">`,
    `<meta name="twitter:image" content="${escapeHtml(meta.ogImage)}">`,
    `<link rel="canonical" href="${escapeHtml(meta.canonical || meta.ogUrl)}">`,
  ].join('\n    ');
  return `${before}\n    ${tags}\n${after}`;
}

app.use(helmet());
// Configure CORS; default to permissive if not set
const corsOriginEnv = process.env.CORS_ORIGIN;
let corsOrigin;
if (corsOriginEnv) {
  // Support comma-separated list of origins
  const origins = corsOriginEnv.split(',').map(o => o.trim());
  corsOrigin = origins.length === 1 ? origins[0] : origins;
  app.use(cors({ origin: corsOrigin }));
} else {
  app.use(cors());
}
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Startup diagnostics (non-sensitive)
console.log('read-api startup env', {
  hasClientId: !!process.env.REDDIT_CLIENT_ID,
  hasClientSecret: !!process.env.REDDIT_CLIENT_SECRET,
  redirectUri: process.env.REDDIT_REDIRECT_URI || null,
  corsOrigin: corsOrigin || '*',
  frontendDistDir: FRONTEND_DIST_DIR || null,
  publicBaseUrl: PUBLIC_BASE_URL || null,
});

// Optional debug endpoint (disabled in production)
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/env', (req, res) => {
    res.json({
      hasClientId: !!process.env.REDDIT_CLIENT_ID,
      hasClientSecret: !!process.env.REDDIT_CLIENT_SECRET,
      redirectUri: process.env.REDDIT_REDIRECT_URI || null,
      corsOrigin: corsOrigin || '*',
      frontendDistDir: FRONTEND_DIST_DIR || null,
      publicBaseUrl: PUBLIC_BASE_URL || null,
      nodeEnv: process.env.NODE_ENV || 'development',
      port,
    });
  });
}

// var certOptions = {
//     key: fs.readFileSync(path.resolve('./config/cert/key.pem')),
//     cert: fs.readFileSync(path.resolve('./config/cert/cert.pem'))
// }

app.get('/', (req, res) => {
  res.send('An alligator approaches!');
});

app.post('/getContent', (req, res) => {
  //console.log('req.body', req.body)
  //res.send('Some data')

  read.readUrl(req.body.url, req.body.token).then(
    (content) => {
      res.send(content);
    },
    (err) => {
      res.send(err);
    }
  );

  // try {
  //     let content = read.readUrl(req.body.url)
  //         .then(())
  //     console.log('content', content)
  //     res.send(content)
  // }
  // catch (err) {
  //     console.log(err)
  //     res.send(err)
  // }
});

const dailyController = require('./controllers/dailyController.js');
const discoverController = require('./controllers/discoverController.js');
const rssService = require('./services/rssService.js');
const briefingController = require('./controllers/briefingController.js');
const userController = require('./controllers/userController.js');
const adminController = require('./controllers/adminController.js');

// Daily Pulse API
app.get('/api/daily/latest', dailyController.getLatestReport);
app.get('/api/daily/:date', dailyController.getReportByDate);
app.post('/api/subscribe', dailyController.subscribe);
app.get('/api/unsubscribe', dailyController.unsubscribe);
app.post('/api/engagement', dailyController.trackEngagement);

// Hourly Discover API (random subreddits)
app.get('/api/hourly/latest', dailyController.getLatestHourlyReport);
app.get('/api/hourly/:hour', dailyController.getHourlyReportByHour);

// Hourly Pulse API (top posts from r/all with top comments)
app.get('/api/hourly-pulse/latest', dailyController.getLatestHourlyPulseReport);
app.get('/api/hourly-pulse/:hour', dailyController.getHourlyPulseReportByHour);

// Trending RSS API (no OAuth required)
app.get('/api/trending/rss', async (req, res) => {
  try {
    const posts = await rssService.getTrendingFromRSS('all', 15);
    res.json({ posts });
  } catch (error) {
    console.error('RSS endpoint error:', error.message);
    res.status(500).json({ error: 'Failed to fetch trending posts' });
  }
});

// Reddit API proxy endpoints
// New OAuth token/refresh endpoints using server env vars
app.post('/api/reddit/oauth/token', redditProxy.oauthToken);
app.post('/api/reddit/oauth/refresh', redditProxy.oauthRefresh);
// Legacy endpoint (expects client_id/secret in body) — kept for backward compatibility
app.post('/api/reddit/access_token', redditProxy.getAccessToken);
app.get('/api/reddit/me', redditProxy.getMe);
app.get('/api/reddit/user/:username/saved', redditProxy.getSaved);
app.post('/api/reddit/unsave', redditProxy.unsave);
app.post('/api/reddit/save', redditProxy.save);
app.get('/api/reddit/by_id/:fullname', redditProxy.getById);
// Public endpoint for fetching post data without auth (for shared links)
app.get('/api/reddit/public/by_id/:fullname', redditProxy.getByIdPublic);

// Subreddit discovery & rotating feed endpoints
app.get('/api/reddit/subreddits/popular', redditProxy.getPopularSubreddits);
app.get('/api/reddit/subreddits/mine', redditProxy.getUserSubreddits); // Pro mode - requires auth
app.get('/api/reddit/feed/rotating', redditProxy.getRotatingFeed);

// Reddit API Status endpoint
app.get('/api/status/reddit', async (req, res) => {
  try {
    const status = await prisma.apiStatus.findUnique({
      where: { id: 'reddit' },
    });

    if (!status) {
      // No status record = assume healthy
      return res.json({
        healthy: true,
        message: 'API status unknown - no restrictions recorded',
      });
    }

    const cooldownRemaining = status.isHealthy
      ? 0
      : Math.max(0, redditService.COOLDOWN_MS - (Date.now() - status.lastCheckedAt.getTime()));

    res.json({
      healthy: status.isHealthy,
      lastCheckedAt: status.lastCheckedAt,
      lastHealthyAt: status.lastHealthyAt,
      lastErrorCode: status.lastErrorCode,
      lastErrorMessage: status.lastErrorMessage,
      failureCount: status.failureCount,
      cooldownRemaining: Math.ceil(cooldownRemaining / 60000), // minutes
      message: status.isHealthy
        ? 'Reddit API is operational'
        : `Reddit API restricted. Cooldown: ${Math.ceil(cooldownRemaining / 60000)} minutes remaining.`,
    });
  } catch (e) {
    console.error('Error fetching API status:', e);
    res.status(500).json({ error: 'Failed to fetch API status' });
  }
});

// Category-Based Discover API (Pro Feature)
app.get('/api/discover/categories', discoverController.getCategories);
app.get('/api/discover/user/:userId/preferences', discoverController.getUserPreferences);
app.post('/api/discover/user/:userId/categories', discoverController.setUserCategories);
app.post('/api/discover/user/:userId/subreddits/toggle', discoverController.toggleSubreddit);
app.post('/api/discover/user/:userId/generate', discoverController.generateReport);
app.get('/api/discover/user/:userId/reports', discoverController.getUserReports);
app.get('/api/discover/user/:userId/reports/latest', discoverController.getLatestReport);

// Global Briefing API (Free tier)
app.get('/api/briefing/latest', briefingController.getLatestBriefing);
app.get('/api/briefing/history', briefingController.getBriefingHistory);
app.get('/api/briefing/:id', briefingController.getBriefingById);

// User API
app.post('/api/user/sync', userController.syncUser);
app.get('/api/user/:redditId', userController.getUser);
app.get('/api/user/:redditId/subscription', userController.getSubscriptionStatus);

// Admin API (protected)
app.get('/api/admin/stats', adminController.requireAdmin, adminController.getStats);
app.get('/api/admin/users', adminController.requireAdmin, adminController.listUsers);
app.post('/api/admin/users/:redditUsername/pro', adminController.requireAdmin, adminController.setUserPro);
app.post('/api/admin/users/:redditUsername/admin', adminController.requireAdmin, adminController.setUserAdmin);
app.get('/api/admin/briefings', adminController.requireAdmin, adminController.listBriefings);
app.post('/api/admin/briefings/:id/regenerate', adminController.requireAdmin, adminController.regenerateBriefing);
app.delete('/api/admin/briefings/:id', adminController.requireAdmin, adminController.deleteBriefing);

// Cron Job Admin API
app.get('/api/admin/jobs', adminController.requireAdmin, adminController.listJobs);
app.patch('/api/admin/jobs/:name', adminController.requireAdmin, adminController.updateJob);
app.post('/api/admin/jobs/:name/trigger', adminController.requireAdmin, adminController.triggerJob);
app.get('/api/admin/jobs/:name/runs', adminController.requireAdmin, adminController.getJobRuns);

// Reddit API Usage
app.get('/api/admin/reddit-usage', adminController.requireAdmin, adminController.getRedditUsage);
app.get('/api/admin/reddit-usage/logs', adminController.requireAdmin, adminController.getRedditUsageLogs);
app.delete('/api/admin/reddit-usage/logs', adminController.requireAdmin, adminController.deleteRedditUsageLogs);

// Dynamic share preview route (inject OG/Twitter tags)
app.get('/p/:fullname', async (req, res) => {
  try {
    const { fullname } = req.params;
    const indexHtml = await readIndexHtml();
    if (!indexHtml) {
      return res.status(500).send('SSR not configured: FRONTEND_DIST_DIR missing or index.html not found');
    }

    let post = null;
    try {
      post = await fetchRedditPublic(fullname);
    } catch (e) {
      // continue with defaults
    }

    const isComment = !!(post && ((post.name && post.name.startsWith('t1_')) || post.body));
    const baseTitle = isComment
      ? `Comment by u/${post.author}${post && post.link_title ? ` on "${post.link_title}"` : ''}`
      : (post && post.title) || 'Reddzit: Review your saved Reddit posts';
    const description = isComment
      ? (post && post.body ? String(post.body).slice(0, 200) : 'Review your saved Reddit posts with Reddzit.')
      : (post && post.selftext ? String(post.selftext).slice(0, 200) : 'Review your saved Reddit posts with Reddzit.');
    const imageUrl = pickPreviewImage(post);
    const ogUrl = (PUBLIC_BASE_URL || '') + req.originalUrl;
    const canonicalUrl = (post && post.permalink) ? `https://www.reddit.com${post.permalink}` : ogUrl;

    const injected = injectMeta(indexHtml, {
      title: `Reddzit: Review your saved Reddit posts — ${baseTitle}`,
      ogTitle: baseTitle,
      ogDescription: description,
      ogImage: imageUrl,
      ogUrl,
      canonical: canonicalUrl,
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=60');
    res.send(injected);
  } catch (err) {
    console.error('SSR route error', err);
    res.status(500).send('Server error');
  }
});

// Support slugged share URLs like /p/:fullname/:slug
app.get('/p/:fullname/:slug', async (req, res) => {
  try {
    const { fullname } = req.params;
    const indexHtml = await readIndexHtml();
    if (!indexHtml) {
      return res.status(500).send('SSR not configured: FRONTEND_DIST_DIR missing or index.html not found');
    }

    let post = null;
    try {
      post = await fetchRedditPublic(fullname);
    } catch (e) {
      // continue with defaults
    }

    const isComment = !!(post && ((post.name && post.name.startsWith('t1_')) || post.body));
    const baseTitle = isComment
      ? `Comment by u/${post.author}${post && post.link_title ? ` on "${post.link_title}"` : ''}`
      : (post && post.title) || 'Reddzit: Review your saved Reddit posts';
    const description = isComment
      ? (post && post.body ? String(post.body).slice(0, 200) : 'Review your saved Reddit posts with Reddzit.')
      : (post && post.selftext ? String(post.selftext).slice(0, 200) : 'Review your saved Reddit posts with Reddzit.');
    const imageUrl = pickPreviewImage(post);
    const ogUrl = (PUBLIC_BASE_URL || '') + req.originalUrl;
    const canonicalUrl = (post && post.permalink) ? `https://www.reddit.com${post.permalink}` : ogUrl;

    const injected = injectMeta(indexHtml, {
      title: `Reddzit: Review your saved Reddit posts — ${baseTitle}`,
      ogTitle: baseTitle,
      ogDescription: description,
      ogImage: imageUrl,
      ogUrl,
      canonical: canonicalUrl,
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=60');
    res.send(injected);
  } catch (err) {
    console.error('SSR route error', err);
    res.status(500).send('Server error');
  }
});

//var server = https.createServer(certOptions, app).listen(port, () => console.log('Alex made a thing at port ' + port))

app.listen(port, () => console.log(`Read API listening on port ${port}!`));

// ============ Cron Job Sync on Startup ============
const pm2Service = require('./services/pm2Service');

async function syncCronJobs() {
  try {
    const jobs = await prisma.cronJob.findMany();
    const dbJobNames = new Set(jobs.map(j => j.name));

    // Clean up orphaned PM2 job processes (exist in PM2 but not in database)
    const pm2Processes = await pm2Service.getProcessList();
    const knownJobPrefixes = ['daily-report', 'discover', 'top-posts', 'hourly-pulse', 'global-briefing'];

    for (const proc of pm2Processes) {
      // Check if this is a job process (not read-api itself) that's not in DB
      if (knownJobPrefixes.includes(proc.name) && !dbJobNames.has(proc.name)) {
        console.log(`[CronSync] Removing orphaned job: ${proc.name}`);
        await pm2Service.deleteProcess(proc.name);
      }
    }

    if (jobs.length === 0) {
      console.log('[CronSync] No cron jobs found in database. Seed them first.');
      return;
    }

    console.log(`[CronSync] Syncing ${jobs.length} cron jobs to PM2...`);

    for (const job of jobs) {
      try {
        await pm2Service.applyJobConfig({
          name: job.name,
          script: job.script,
          cronExpression: job.cronExpression,
          enabled: job.enabled,
        });
        console.log(`[CronSync]   - ${job.name}: ${job.enabled ? 'enabled' : 'disabled'}`);
      } catch (e) {
        console.error(`[CronSync]   - ${job.name}: failed - ${e.message}`);
      }
    }
    console.log('[CronSync] Complete.');
  } catch (e) {
    console.error('[CronSync] Failed to sync cron jobs:', e.message);
  }
}

// Run sync after a short delay to ensure DB is ready
setTimeout(syncCronJobs, 3000);
