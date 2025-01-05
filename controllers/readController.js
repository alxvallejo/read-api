var read = require('node-readability');

module.exports = {
  readUrl: (url, token) => {
    return new Promise((resolve, reject) => {
      let httpsUrl = url.replace('http://', 'https://');
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
              resolve({ content, title });
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
