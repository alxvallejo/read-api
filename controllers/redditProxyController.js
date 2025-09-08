const fetch = require('node-fetch');

const UA = process.env.USER_AGENT || 'Reddzit/1.0';
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const REDDIT_REDIRECT_URI = process.env.REDDIT_REDIRECT_URI;

function getBasicAuthHeader() {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return null;
  const credentials = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  return `Basic ${credentials}`;
}

const redditProxy = {
  async proxyRequest(url, options = {}) {
    try {
      const response = await fetch(url, options);
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Reddit proxy error:', error);
      throw error;
    }
  },

  async getMe(req, res) {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
      }

      const data = await redditProxy.proxyRequest('https://oauth.reddit.com/api/v1/me', {
        headers: {
          'Authorization': authHeader,
          'User-Agent': UA
        }
      });

      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  async getSaved(req, res) {
    try {
      const authHeader = req.headers.authorization;
      const username = req.params.username;
      const queryParams = req.query;
      
      if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
      }

      let url = `https://oauth.reddit.com/user/${username}/saved`;
      if (Object.keys(queryParams).length > 0) {
        const params = new URLSearchParams(queryParams);
        url += `?${params}`;
      }

      const data = await redditProxy.proxyRequest(url, {
        headers: {
          'Authorization': authHeader,
          'User-Agent': UA
        }
      });

      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  async unsave(req, res) {
    try {
      const authHeader = req.headers.authorization;
      const { id } = req.body;
      
      if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
      }

      const queryString = require('querystring');
      const response = await fetch('https://oauth.reddit.com/api/unsave', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA
        },
        body: queryString.stringify({ id })
      });

      res.status(response.status).send();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  async save(req, res) {
    try {
      const authHeader = req.headers.authorization;
      const { id } = req.body;
      
      if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
      }

      const queryString = require('querystring');
      const response = await fetch('https://oauth.reddit.com/api/save', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA
        },
        body: queryString.stringify({ id })
      });

      res.status(response.status).send();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  async getById(req, res) {
    try {
      const authHeader = req.headers.authorization;
      const { fullname } = req.params;
      
      if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
      }

      const data = await redditProxy.proxyRequest(`https://oauth.reddit.com/by_id/${fullname}`, {
        headers: {
          'Authorization': authHeader,
          'User-Agent': UA
        }
      });

      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  async getAccessToken(req, res) {
    try {
      const { code, redirect_uri, client_id, client_secret } = req.body;
      
      if (!code || !redirect_uri || !client_id || !client_secret) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }

      const queryString = require('querystring');
      const credentials = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
      
      const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA
        },
        body: queryString.stringify({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: redirect_uri
        })
      });

      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  async oauthToken(req, res) {
    try {
      const { code } = req.body || {};
      if (!code) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });
      }
      const authHeader = getBasicAuthHeader();
      if (!authHeader || !REDDIT_REDIRECT_URI) {
        return res.status(500).json({ error: 'server_config', message: 'Missing Reddit env vars' });
      }

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDDIT_REDIRECT_URI,
      });

      const r = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: params,
      });
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = {}; }
      res.status(r.status).json(json);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  async oauthRefresh(req, res) {
    try {
      const { refresh_token } = req.body || {};
      if (!refresh_token) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });
      }
      const authHeader = getBasicAuthHeader();
      if (!authHeader) {
        return res.status(500).json({ error: 'server_config', message: 'Missing Reddit env vars' });
      }

      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
      });

      const r = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: params,
      });
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = {}; }
      res.status(r.status).json(json);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
};

module.exports = redditProxy;
