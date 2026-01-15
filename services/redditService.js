const fetch = require('node-fetch');

const UA = process.env.USER_AGENT || 'Reddzit/1.0';
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;

// Feature flag to disable comment fetching (reduces API calls)
const SKIP_COMMENTS = process.env.SKIP_REDDIT_COMMENTS === 'true';

// Error codes that indicate API access is restricted
const RESTRICTED_ERROR_CODES = [401, 403, 429];

// Cooldown period before retrying restricted API (3 hours)
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

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

async function getTopPosts(subreddit, limit = 5, prisma = null) {
  const endpoint = `/r/${subreddit}/top?t=day&limit=${limit}`;
  const data = prisma
    ? await fetchRedditWithStatusTracking(endpoint, prisma)
    : await fetchReddit(endpoint);
  return data.data.children.map(child => child.data);
}

async function getPostComments(articleId, prisma = null) {
    // Skip comment fetching if disabled (to reduce API calls)
    if (SKIP_COMMENTS) {
      return [];
    }

    // articleId should be without t3_ prefix for the endpoint usually,
    // but the permalink or /comments/id endpoint handles it.
    // If we have permalink, we can use that, but better to use /comments/{id}
    // articleId from listing is usually like '12345' (no t3_).

    // We want top comments, maybe controversial too?
    // Reddit API allows sorting.
    // GET /comments/article

    const endpoint = `/comments/${articleId}?sort=top&limit=20&depth=2`;
    const data = prisma
      ? await fetchRedditWithStatusTracking(endpoint, prisma)
      : await fetchReddit(endpoint);
    // data is an array: [listing (post), listing (comments)]
    const comments = data[1].data.children.map(child => child.data).filter(c => c.body); // filter out 'more'
    return comments;
}

// Record API status in database
async function recordApiStatus(prisma, isHealthy, errorCode = null, errorMessage = null) {
  const now = new Date();

  try {
    await prisma.apiStatus.upsert({
      where: { id: 'reddit' },
      update: {
        isHealthy,
        lastCheckedAt: now,
        lastHealthyAt: isHealthy ? now : undefined,
        lastErrorCode: isHealthy ? null : errorCode,
        lastErrorMessage: isHealthy ? null : errorMessage,
        failureCount: isHealthy ? 0 : { increment: 1 },
      },
      create: {
        id: 'reddit',
        isHealthy,
        lastCheckedAt: now,
        lastHealthyAt: isHealthy ? now : null,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
        failureCount: isHealthy ? 0 : 1,
      },
    });
  } catch (e) {
    console.error('Failed to record API status:', e.message);
  }
}

// Perform a lightweight health check against Reddit API
async function performHealthCheck() {
  try {
    const token = await getAccessToken();
    const response = await fetch('https://oauth.reddit.com/api/v1/me', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': UA,
      },
    });

    return {
      healthy: response.ok,
      statusCode: response.status,
      message: response.ok ? null : response.statusText,
    };
  } catch (e) {
    return {
      healthy: false,
      statusCode: null,
      message: e.message,
    };
  }
}

// Check if Reddit API is currently restricted
// If cooldown has passed, performs a health check and updates status
async function isApiRestricted(prisma) {
  try {
    const status = await prisma.apiStatus.findUnique({
      where: { id: 'reddit' },
    });

    // No status record = assume healthy
    if (!status) {
      return false;
    }

    // If already healthy, not restricted
    if (status.isHealthy) {
      return false;
    }

    // Check if cooldown period has passed
    const timeSinceLastCheck = Date.now() - status.lastCheckedAt.getTime();
    if (timeSinceLastCheck < COOLDOWN_MS) {
      console.log(`Reddit API restricted. Cooldown: ${Math.ceil((COOLDOWN_MS - timeSinceLastCheck) / 60000)} minutes remaining.`);
      return true;
    }

    // Cooldown passed - perform health check
    console.log('Cooldown passed. Performing Reddit API health check...');
    const healthResult = await performHealthCheck();

    await recordApiStatus(
      prisma,
      healthResult.healthy,
      healthResult.statusCode,
      healthResult.message
    );

    if (healthResult.healthy) {
      console.log('Reddit API recovered! Proceeding with report generation.');
      return false;
    } else {
      console.log(`Reddit API still restricted (${healthResult.statusCode}): ${healthResult.message}`);
      return true;
    }
  } catch (e) {
    console.error('Error checking API restriction status:', e.message);
    // On error checking status, proceed cautiously (assume not restricted)
    return false;
  }
}

// Log API request (non-blocking)
async function logApiRequest(prisma, endpoint, status) {
  if (!prisma) return;
  try {
    await prisma.redditApiLog.create({
      data: { endpoint, status }
    });
  } catch (e) {
    console.error('Failed to log API request:', e.message);
  }
}

// Wrapper for fetchReddit that records API status on restricted errors
async function fetchRedditWithStatusTracking(endpoint, prisma) {
  let status = 0;
  try {
    const token = await getAccessToken();
    const response = await fetch(`https://oauth.reddit.com${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': UA,
      },
    });

    status = response.status;

    if (!response.ok) {
      const isRestricted = RESTRICTED_ERROR_CODES.includes(response.status);

      if (isRestricted && prisma) {
        console.error(`Reddit API restricted: ${response.status} ${response.statusText}`);
        await recordApiStatus(prisma, false, response.status, response.statusText);
      }

      throw new Error(`Reddit API error ${response.status}: ${response.statusText}`);
    }

    // Record success if prisma client provided
    if (prisma) {
      await recordApiStatus(prisma, true);
    }

    return response.json();
  } catch (e) {
    // Re-throw the error after recording status
    throw e;
  } finally {
    // Log request regardless of success/failure (non-blocking)
    logApiRequest(prisma, endpoint, status).catch(() => {});
  }
}

module.exports = {
  getTopPosts,
  getPostComments,
  isApiRestricted,
  recordApiStatus,
  performHealthCheck,
  fetchRedditWithStatusTracking,
  RESTRICTED_ERROR_CODES,
  COOLDOWN_MS,
};
