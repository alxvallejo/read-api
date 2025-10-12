# Read API

Backend API for Reddzit. Provides:
- Content extraction (`POST /getContent`)
- Reddit API proxy endpoints (so the frontend never talks directly to Reddit OAuth)

The Node server runs behind PM2 in production. For local development it supports auto-reload via nodemon. If it stops, you can restart it on the server with:

```
cd /var/www/read-api
pm2 start server.js --name read-api -i 2 --update-env
```

Local development with auto-restart:

```
# install deps
npm install

# copy and configure env
cp .env.example .env

# run with auto-reload on code changes
npm run dev
```

## Environment Variables

Define these in your server environment (PM2 ecosystem, shell profile, or deployment env). Do not expose secrets in the frontend.

- `REDDIT_CLIENT_ID`: Reddit app client id.
- `REDDIT_CLIENT_SECRET`: Reddit app client secret (server-only).
- `REDDIT_REDIRECT_URI`: The exact redirect URI registered in your Reddit app (e.g., `https://reddzit.seojeek.com/reddit`).
- `CORS_ORIGIN` (optional but recommended): Allowed browser origin, e.g., `https://reddzit.seojeek.com` (defaults to `*` if not set).
- `PORT` (optional): Defaults to `3000`.
- `USER_AGENT` (optional): Custom UA for Reddit requests (defaults to `Reddzit/1.0`).
// SSR for frontend share previews
- `FRONTEND_DIST_DIR` (optional for SSR): Absolute path to the frontend build directory that contains `index.html` and `assets/`.
  - Prod example: `/var/www/reddzit-refresh/dist`
  - Local example: `/Users/<you>/Sites/personal/reddzit/reddzit-refresh/dist`
- `PUBLIC_BASE_URL` (optional for SSR): Public origin used to generate absolute `og:url` and fallback image URLs.
  - Prod example: `https://reddzit.seojeek.com`
  - Local example: `http://localhost:3000`

Example (local dev, shell export):

```
export REDDIT_CLIENT_ID=abc123
export REDDIT_CLIENT_SECRET=supersecret
export REDDIT_REDIRECT_URI=http://localhost:5173/reddit
export CORS_ORIGIN=http://localhost:5173
export PORT=3000
pm2 start server.js --name read-api --update-env
```

Example (PM2 ecosystem):

```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'read-api',
    script: 'server.js',
    instances: 2,
    env: {
      PORT: 3000,
      CORS_ORIGIN: 'https://reddzit.seojeek.com',
      REDDIT_CLIENT_ID: '... set on server ...',
      REDDIT_CLIENT_SECRET: '... set on server ...',
      REDDIT_REDIRECT_URI: 'https://reddzit.seojeek.com/reddit',
      USER_AGENT: 'Reddzit/1.0',
    },
  }],
};
```

### Recommended: .env for local, PM2 for production

This project loads a `.env` file via `dotenv` for local development, while production continues to use PM2 (or systemd) environment configuration. Precedence is: PM2/systemd env > shell env > `.env`.

Local setup with `.env`:
- Copy `.env.example` to `.env` and fill values.
- Typical local values:
  - `FRONTEND_DIST_DIR=/absolute/path/to/reddzit-refresh/dist`
  - `PUBLIC_BASE_URL=http://localhost:3000`
  - Reddit OAuth vars if you exercise those endpoints locally.
- Start the server: `npm run dev` or `node server.js`.

Production with PM2:
- Keep envs in `ecosystem.config.js` (or set them in the shell before `pm2 start`).
- Restart with `pm2 restart read-api --update-env` to reload env changes.

Production with systemd (alternative):
- Add envs to `/etc/systemd/system/read-api.service` using `Environment=KEY=VALUE` or `EnvironmentFile=/etc/default/read-api`.
- Reload and restart: `sudo systemctl daemon-reload && sudo systemctl restart read-api`.

Inspecting runtime envs on the server:
- systemd unit vars: `sudo systemctl show -p Environment read-api`
- process env (by PID): `pid=$(systemctl show -p MainPID --value read-api); sudo tr '\0' '\n' </proc/$pid/environ | sort`
- PM2 app config: `pm2 describe read-api`

## OAuth Token Proxy (Recommendation)

To avoid CORS issues and keep secrets safe, the backend should perform the Reddit OAuth token exchange and refresh using server-side env vars. Do not send the Reddit secret from the client.

Current endpoint:
- `POST /api/reddit/access_token` (legacy): expects `client_id`, `client_secret`, and `redirect_uri` in the body. This should be deprecated in favor of server-configured env vars.

Recommended endpoints (to add):
- `POST /api/reddit/oauth/token` — Body: `{ code }` (server uses env credentials and `REDDIT_REDIRECT_URI`).
- `POST /api/reddit/oauth/refresh` — Body: `{ refresh_token }`.

Suggested implementation sketch:

```js
// Use env vars
const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_REDIRECT_URI } = process.env;
const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');

app.post('/api/reddit/oauth/token', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'invalid_request' });
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDDIT_REDIRECT_URI });
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  return res.status(r.status).json(j);
});

app.post('/api/reddit/oauth/refresh', async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: 'invalid_request' });
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token });
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  return res.status(r.status).json(j);
});
```

## CORS Configuration

Restrict CORS to your SPA’s origin in `server.js`:

```js
const cors = require('cors');
app.use(cors({ origin: process.env.CORS_ORIGIN || '*'}));
```

## Existing Reddit Proxy Endpoints

These endpoints proxy Reddit API calls using the bearer token from the client:

- `GET /api/reddit/me`
- `GET /api/reddit/user/:username/saved`
- `POST /api/reddit/save` — Body: `{ id }`
- `POST /api/reddit/unsave` — Body: `{ id }`
- `GET /api/reddit/by_id/:fullname`

## Deployment via Bitbucket Pipelines

The pipeline deploys to the server and restarts via PM2. Ensure required environment variables are present on the server. PM2’s `--update-env` reloads environment variables on restart.

## Notes

- Do not accept `client_secret` from the client; keep secrets server-side only.
- The frontend should call the backend for token/refresh; it must not POST to Reddit’s token endpoint directly (CORS will block it).
- Ensure `REDDIT_REDIRECT_URI` matches exactly what is configured in the Reddit app (including path like `/reddit`).

## GitHub Actions Deployment

This repo includes a GitHub Actions workflow at `.github/workflows/deploy-read-api.yml` to build and deploy over SSH.

- Required repository secrets:
  - `SSH_HOST`: e.g. `seojeek.com`
  - `SSH_USER`: e.g. `alxvallejo`
  - `SSH_KEY`: private key used by Actions to SSH to the server
  - `SSH_PORT` (optional): e.g. `22`

- Generate and install the deploy key (example):
  1. `ssh-keygen -t ed25519 -C "github-actions@read-api" -f ~/.ssh/read_api_actions -N ''`
  2. `ssh-copy-id -i ~/.ssh/read_api_actions.pub alxvallejo@seojeek.com`
     - or append the `.pub` content to `/home/alxvallejo/.ssh/authorized_keys` on the server
  3. Add the private key value to the GitHub repo secret `SSH_KEY`.

- The workflow uploads a tarball to `/tmp/read-api.tar.gz`, extracts into `/var/www/read-api`, runs `npm ci --production`, and starts/restarts via PM2.
## Share Preview SSR for Frontend

This service can inject dynamic Open Graph and Twitter meta tags for the frontend’s share URLs (e.g., `/p/:fullname`) so social platforms show accurate previews.

Configure (now supports .env):
- `FRONTEND_DIST_DIR`: absolute path to the frontend build directory (e.g., `/var/www/reddzit-refresh/dist`).
- `PUBLIC_BASE_URL`: e.g., `https://reddzit.seojeek.com` (used for absolute `og:url` and default image).

Using dotenv:
- Copy `.env.example` to `.env` and fill values. The server loads it automatically.
  - Optional CORS: set `CORS_ORIGIN` to your frontend origin (e.g., `http://localhost:5173` in dev, `https://reddzit.seojeek.com` in prod). If unset, CORS is permissive.
  - Local SSR test: set `FRONTEND_DIST_DIR` to your local frontend build (absolute path), e.g., `/Users/alexvallejo/Sites/personal/reddzit/reddzit-refresh/dist`, and `PUBLIC_BASE_URL=http://localhost:3000`. Build the frontend first: `cd reddzit-refresh && npm run build`.

Nginx example:
- Serve static files from `FRONTEND_DIST_DIR`.
- Proxy only `/p/` routes to this server (port `3000` by default):

```
location ~ ^/p/.*$ {
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_pass http://127.0.0.1:3000;
}
```

Canonical URL redirect (optional but recommended):
- Redirect legacy share links like `/reddit?name=t3_abcdef` to the canonical `/p/t3_abcdef` so social bots hit the SSR path directly.

```
location = /reddit {
  # If the query contains a valid Reddit fullname, redirect to canonical
  if ($arg_name ~* "^t[13]_[A-Za-z0-9]+$") { return 301 /p/$arg_name; }
  # Otherwise, serve SPA
  try_files $uri /index.html;
}
```

Notes:
- The route fetches public Reddit JSON from `https://www.reddit.com/by_id/:fullname.json` (no OAuth required) and injects tags into `index.html` in memory; no files are created per post.
- If `index.html` changes, it is reloaded automatically based on its modification time.
