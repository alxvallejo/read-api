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

// Use the same User-Agent as other Reddit API calls
const UA = process.env.USER_AGENT || 'Reddzit/1.0';

// App-only OAuth token cache for SSR
let APP_TOKEN = null;
let APP_TOKEN_EXPIRES = 0;

async function getAppOnlyToken() {
  // Return cached token if still valid
  if (APP_TOKEN && Date.now() < APP_TOKEN_EXPIRES) {
    return APP_TOKEN;
  }
  
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    console.warn('SSR: Reddit OAuth credentials not configured');
    return null;
  }
  
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await nodeFetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA
      },
      body: 'grant_type=client_credentials'
    });
    
    if (!response.ok) {
      console.error('SSR: Failed to get app token, status:', response.status);
      return null;
    }
    
    const data = await response.json();
    APP_TOKEN = data.access_token;
    // Expire 5 minutes before actual expiry for safety
    APP_TOKEN_EXPIRES = Date.now() + (data.expires_in - 300) * 1000;
    console.log('SSR: Obtained new app-only OAuth token');
    return APP_TOKEN;
  } catch (err) {
    console.error('SSR: Error getting app token:', err.message);
    return null;
  }
}

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
  // Use Reddit's OAuth API with app-only credentials for reliable, unblocked access
  const token = await getAppOnlyToken();
  
  if (!token) {
    console.warn('SSR: No OAuth token available, falling back to public API');
    // Fallback to public API without auth
    const postId = fullname.replace('t3_', '');
    const jsonUrl = `https://www.reddit.com/comments/${postId}/.json`;
    console.log('SSR: Fetching Reddit post JSON (public):', jsonUrl);
    
    try {
      const response = await nodeFetch(jsonUrl, {
        headers: {
          'User-Agent': UA,
        },
        redirect: 'follow'
      });
      
      if (!response.ok) {
        console.error('SSR: Public API returned status:', response.status);
        return null;
      }
      
      const text = await response.text();
      console.log('SSR: Received response, length:', text.length);
      const parsed = JSON.parse(text);
      const postData = parsed[0]?.data?.children?.[0]?.data;
      
      if (!postData) {
        console.log('SSR: No post data found in JSON response');
        return null;
      }
      
      return {
        title: postData.title || 'Reddit Post',
        selftext: postData.selftext || '',
        author: postData.author || 'reddit user',
        subreddit: postData.subreddit || 'unknown',
        name: fullname,
        permalink: postData.permalink || `/comments/${postData.id}/`,
        preview: postData.preview
      };
    } catch (err) {
      console.error('SSR: Public API error:', err.message);
      return null;
    }
  }
  
  // Use authenticated OAuth endpoint
  const apiUrl = `https://oauth.reddit.com/by_id/${fullname}`;
  console.log('SSR: Fetching via OAuth API:', apiUrl);
  
  try {
    const response = await nodeFetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': UA,
      },
      redirect: 'follow'
    });
    
    if (!response.ok) {
      console.error('SSR: Reddit API returned status:', response.status);
      return null;
    }
    
    const text = await response.text();
    console.log('SSR: Received response, length:', text.length);
    
    const parsed = JSON.parse(text);
    
    // Reddit JSON structure: [post_data, comments_data]
    const postData = parsed[0]?.data?.children?.[0]?.data;
    if (!postData) {
      console.log('SSR: No post data found in JSON response');
      return null;
    }
    
    const title = postData.title;
    const description = postData.selftext || '';
    const author = postData.author;
    const subreddit = postData.subreddit;
    const permalink = postData.permalink;
    
    console.log('SSR: Extracted from JSON API:', {
      title: title?.slice(0, 50) + '...',
      author,
      subreddit,
      hasDescription: !!description
    });
    
    const post = {
      title: title || 'Reddit Post',
      selftext: description,
      author: author || 'reddit user',
      subreddit: subreddit || 'unknown',
      name: fullname,
      permalink: permalink || `/comments/${postData.id}/`,
      preview: postData.preview // Include preview for image extraction
    };
    
    return post;
  } catch (err) {
    console.error('SSR: Failed to fetch Reddit data:', err.message);
    return null;
  }
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
const corsOrigin = process.env.CORS_ORIGIN;
if (corsOrigin) {
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

// Dynamic share preview route (inject OG/Twitter tags)
app.get('/p/:fullname', async (req, res) => {
  try {
    const { fullname } = req.params;
    console.log('SSR: Processing request for fullname:', fullname);
    console.log('SSR: Full request URL:', req.originalUrl);
    const indexHtml = await readIndexHtml();
    if (!indexHtml) {
      return res.status(500).send('SSR not configured: FRONTEND_DIST_DIR missing or index.html not found');
    }

    let post = null;
    try {
      post = await fetchRedditPublic(fullname);
      console.log('SSR: Successfully fetched post data for', fullname, post ? 'SUCCESS' : 'NO_DATA');
    } catch (e) {
      console.error('SSR: Failed to fetch Reddit post data for', fullname, e.message || e);
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
    console.log('SSR: Processing slugged request for fullname:', fullname);
    console.log('SSR: Full slugged request URL:', req.originalUrl);
    const indexHtml = await readIndexHtml();
    if (!indexHtml) {
      return res.status(500).send('SSR not configured: FRONTEND_DIST_DIR missing or index.html not found');
    }

    let post = null;
    try {
      post = await fetchRedditPublic(fullname);
      console.log('SSR: Successfully fetched post data for', fullname, post ? 'SUCCESS' : 'NO_DATA');
    } catch (e) {
      console.error('SSR: Failed to fetch Reddit post data for', fullname, e.message || e);
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
