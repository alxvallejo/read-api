require('dotenv').config();
const read = require('./controllers/readController.js');
const redditProxy = require('./controllers/redditProxyController.js');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const https = require('https');
const app = express();
const port = process.env.PORT || 3000;
const nodeFetch = require('node-fetch');

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
  const endpoint = `https://www.reddit.com/by_id/${encodeURIComponent(fullname)}.json`;
  const r = await nodeFetch(endpoint, { headers: { 'User-Agent': 'Reddzit/preview' } });
  if (!r.ok) throw new Error('Reddit fetch failed: ' + r.status);
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

// Daily Pulse API
app.get('/api/daily/latest', dailyController.getLatestReport);
app.get('/api/daily/:date', dailyController.getReportByDate);
app.post('/api/subscribe', dailyController.subscribe);
app.get('/api/unsubscribe', dailyController.unsubscribe);
app.post('/api/engagement', dailyController.trackEngagement);

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
