**Overview**
- **Purpose:** Backend API and content reader for Reddzit.
- **Stack:** Node.js + Express, `node-readability` for article extraction, `node-fetch` for Reddit proxying.
- **Entry points:** `server.js` (Express app), `cluster.js` (multiprocess runner).

**Components**
- **Express App (`server.js`):** Sets up CORS, JSON body parsing, and security headers via `helmet`. Binds routes and listens on `:3000`.
- **Read Controller (`controllers/readController.js`):** Fetches a given URL and extracts readable `title` and `content` via `node-readability`.
- **Reddit Proxy (`controllers/redditProxyController.js`):** Thin proxy to Reddit OAuth endpoints. Forwards auth headers and returns JSON.
- **Cluster Runner (`cluster.js`):** Optional multi‑CPU process forking that loads `server.js` in each worker.

**Routes**
- `GET /`: Health check. Returns a simple string.
- `POST /getContent`: Extracts readable content from a URL. Body: `{ url, token }`.
- `POST /api/reddit/access_token`: Exchanges an OAuth `code` for access token.
- `GET /api/reddit/me`: Returns the authenticated Reddit user.
- `GET /api/reddit/user/:username/saved`: Returns saved items for `:username`.
- `POST /api/reddit/unsave`: Unsave a thing by fullname `id`.
- `POST /api/reddit/save`: Save a thing by fullname `id`.
- `GET /api/reddit/by_id/:fullname`: Look up a thing by fullname.

**Request Flow: Access Token Exchange**
- **Client → API:** `POST /api/reddit/access_token` with `{ code, redirect_uri, client_id, client_secret }`.
- **API → Reddit:** Posts to `https://www.reddit.com/api/v1/access_token` with basic auth and form body.
- **Reddit → API:** Returns access and refresh tokens as JSON.
- **API → Client:** Forwards the token JSON to the client unchanged.

**Request Flow: Authenticated Reddit Calls**
- **Client → API:** Send request to any `/api/reddit/*` route with `Authorization: Bearer <token>` header.
- **API → Reddit:** Forwards the request to `https://oauth.reddit.com/...` with same `Authorization` and `User-Agent: Reddzit/1.0`.
- **Reddit → API:** Responds with JSON for the resource (e.g., `/me`, `/user/:username/saved`).
- **API → Client:** Forwards the JSON body. On missing auth header, returns `401`. On errors, returns `500` with `{ error }`.

**Request Flow: Content Extraction**
- **Client → API:** `POST /getContent` with JSON body `{ url, token }`.
- **API (prep):** Converts `http://` to `https://` for the target URL to avoid mixed content issues.
- **API (comment detection):** If `url` matches a Reddit comment permalink (`/comments/<post>/<slug>/<commentId>`), fetches the comment via Reddit (`by_id/t1_<commentId>`) and returns a structured object with `type: 'comment'`, `title`, `content` (HTML), `author`, `score`, `created_utc`, `permalink`, and ids.
- **API (fetch article):** Otherwise uses `node-readability` to fetch the URL with headers:
  - `User-Agent: web:socket:v1.2.0 (by /u/no_spoon)`
  - `Authorization: Bearer <token>` (sent as‑is; useful if the target requires OAuth)
- **API (parse):** Extracts `article.title` and `article.content`. Calls `article.close()` to free resources.
- **API → Client:** Returns `{ type: 'comment', ... }` for comment URLs, or `{ type: 'article', title, content }` for articles. If extraction fails or no article is produced, returns `null` payload or an error.

**Headers & Auth**
- **Authorization:** Client must include `Authorization: Bearer <token>` for Reddit proxy endpoints. `/getContent` accepts a `token` in the body and forwards it as `Authorization` for the upstream fetch.
- **User-Agent:** Reddit proxy uses `Reddzit/1.0`. Content extraction uses a Reddit‑style UA string.

**Error Handling**
- **Missing auth header:** Reddit proxy endpoints return `401` with `{ error }`.
- **Upstream failures:** Generic `500` with `{ error: error.message }` for proxy routes.
- **Readability failures:** If no `article` is produced, the API resolves with `null`; exceptions are caught and rejected.

**Runtime Details**
- **Port:** Listens on `3000` (hardcoded).
- **Security:** `helmet` applied; CORS enabled for cross‑origin use.
- **Process model:** `server.js` runs single process. Use `cluster.js` to fork across CPU cores.

**Local Development Notes**
- Start the app: `node server.js` (or `node cluster.js` for multiprocess).
- Ensure client calls include proper `Authorization` headers and required bodies noted above.
- For production, a process manager (e.g., pm2) can be used; see `readme.md` for a brief note.
