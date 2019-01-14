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
                    // debugger;
                    //console.log(meta)
                    let content = article ? article.content : null;

                    if (!article) {
                        resolve(null)
                    } else {
                        article.close()
                        resolve(content)
                    }


                })
            }
            catch (error) {
                reject(error)
            }
        })
    }
}

