var read = require('node-readability');
const fetch = require('node-fetch');

function parseRedditCommentId(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const host = u.hostname.replace(/^www\./, '').replace(/^old\./, '');
    if (host !== 'reddit.com' && host !== 'oauth.reddit.com' && host !== 'np.reddit.com' && host !== 'new.reddit.com') {
      return null;
    }

    // Typical formats:
    // /r/<sub>/comments/<postId>/<slug>/<commentId>
    // /comments/<postId>/<slug>/<commentId>
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('comments');
    if (idx === -1) return null;
    // Expect at least: comments, <postId>, <slug>, <commentId>
    if (parts.length >= idx + 4) {
      const commentId = parts[idx + 3];
      if (commentId && /^\w+$/i.test(commentId)) {
        return commentId;
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  readUrl: (url, token) => {
    return new Promise((resolve, reject) => {
      let httpsUrl = url.replace('http://', 'https://');
      const commentId = parseRedditCommentId(httpsUrl);
      if (commentId) {
        // Handle Reddit comment permalinks specially
        (async () => {
          try {
            const fullname = `t1_${commentId}`;
            const headers = {
              'User-Agent': 'Reddzit/1.0'
            };
            if (token) headers['Authorization'] = 'Bearer ' + token;

            const byIdUrl = token
              ? `https://oauth.reddit.com/by_id/${fullname}`
              : `https://www.reddit.com/by_id/${fullname}.json`;

            const resp = await fetch(byIdUrl, { headers });
            const data = await resp.json();
            const child = data && data.data && Array.isArray(data.data.children) && data.data.children[0];
            const thing = child && child.data;
            if (thing) {
              const result = {
                type: 'comment',
                id: thing.name,
                author: thing.author,
                score: thing.score,
                created_utc: thing.created_utc,
                permalink: thing.permalink ? `https://reddit.com${thing.permalink}` : undefined,
                parent_id: thing.parent_id,
                link_id: thing.link_id,
                title: thing.link_title || `Comment by u/${thing.author}`,
                content: thing.body_html || null
              };
              return resolve(result);
            }
            // If we didn't get a thing, fall through to readability below
          } catch (err) {
            // If comment fetch fails, fall back to readability below
          }

          // Fall back to readability flow if not resolved above
          try {
            read(
              httpsUrl,
              {
                headers: {
                  'User-Agent': 'web:socket:v1.2.0 (by /u/no_spoon)',
                  Authorization: 'Bearer ' + token,
                },
              },
              (err, article, meta) => {
                if (!article) {
                  return reject(null);
                }
                let content = article ? article.content : null;
                let title = article ? article.title : null;
                if (!article) {
                  resolve(null);
                } else {
                  article.close();
                  resolve({ type: 'article', content, title });
                }
              }
            );
          } catch (error) {
            console.log('error on readUrl fallback: ', error);
            reject(error);
          }
        })();
        return;
      }
      try {
        read(
          httpsUrl,
          {
            headers: {
              'User-Agent': 'web:socket:v1.2.0 (by /u/no_spoon)',
              Authorization: 'Bearer ' + token,
            },
          },
          (err, article, meta) => {
            if (!article) {
              reject(null);
            }
            // debugger;
            //console.log(meta)
            // console.log('article: ', article);
            let content = article ? article.content : null;

            let title = article ? article.title : null;

            if (!article) {
              resolve(null);
            } else {
              article.close();
              resolve({ type: 'article', content, title });
            }
          }
        );
      } catch (error) {
        console.log('error on readUrl: ', error);
        reject(error);
      }
    });
  },
};
