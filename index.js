var path = require('path')
var fs = require('fs')
const express = require('express');
var helmet = require('helmet')
var https = require('https')
const app = express();
app.use(helmet())
const port = 3000

var certOptions = {
    key: fs.readFileSync(path.resolve('./config/cert/key.pem')),
    cert: fs.readFileSync(path.resolve('./config/cert/cert.pem'))
}

app.get('/', (req, res) => {
    res.send('An alligator approaches!');
});

app.get('/getContent', (req, res) => {
    console.log('req', req)
    res.send('Some data')
})

var server = https.createServer(certOptions, app).listen(port, () => console.log('Alex made a thing at port ' + port))

// app.listen(3000, () => console.log('Gator app listening on port 3000!'));