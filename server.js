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

//var server = https.createServer(certOptions, app).listen(port, () => console.log('Alex made a thing at port ' + port))

app.listen(port, () => console.log(`Read API listening on port ${port}!`));
