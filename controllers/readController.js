var read = require('node-readability');


module.exports = {
    readUrl: (url) => {
        return new Promise((resolve, reject) => {
            let httpsUrl = url.replace("http://", "https://");
            try {
                read(httpsUrl, (err, article, meta) => {
                    if (!article) {
                        reject(null)
                    }
                    let content = article ? article.content : null;

                    article.close()
                    resolve(content)
                })
            }
            catch (error) {
                reject(error)
            }
        })
    }
}

