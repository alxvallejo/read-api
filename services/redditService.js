const fetch = require('node-fetch');

const UA = process.env.USER_AGENT || 'Reddzit/1.0';
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;

let accessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  const credentials = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
  });

  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Failed to get access token: ${response.statusText}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  // Expires in is usually 3600 seconds. Subtract 5 mins for safety.
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  
  return accessToken;
}

async function fetchReddit(endpoint) {
  const token = await getAccessToken();
  const response = await fetch(`https://oauth.reddit.com${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': UA,
    },
  });

  if (!response.ok) {
    throw new Error(`Reddit API error ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function getTopPosts(subreddit, limit = 5) {
  const data = await fetchReddit(`/r/${subreddit}/top?t=day&limit=${limit}`);
  return data.data.children.map(child => child.data);
}

async function getPostComments(articleId) {
    // articleId should be without t3_ prefix for the endpoint usually, 
    // but the permalink or /comments/id endpoint handles it.
    // If we have permalink, we can use that, but better to use /comments/{id}
    // articleId from listing is usually like '12345' (no t3_).
    
    // We want top comments, maybe controversial too?
    // Reddit API allows sorting.
    // GET /comments/article
    
    const data = await fetchReddit(`/comments/${articleId}?sort=top&limit=20&depth=2`);
    // data is an array: [listing (post), listing (comments)]
    const comments = data[1].data.children.map(child => child.data).filter(c => c.body); // filter out 'more'
    return comments;
}

module.exports = {
  getTopPosts,
  getPostComments
};
