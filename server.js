const read = require('./controllers/readController.js');
var cors = require('cors');
var bodyParser = require('body-parser');
var path = require('path');
var fs = require('fs');
const express = require('express');
var helmet = require('helmet');
var https = require('https');
const app = express();
const port = 3000;

app.use(helmet());
app.use(cors());
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

  read.readUrl(req.body.url).then(
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

//var server = https.createServer(certOptions, app).listen(port, () => console.log('Alex made a thing at port ' + port))

app.listen(3000, () => console.log('Gator app listening on port 3000!'));
