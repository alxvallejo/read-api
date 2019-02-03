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
                    let title = article ? article.title : null;

                    if (!article) {
                        resolve(null)
                    } else {
                        article.close()
                        resolve({ content, title })
                    }


                })
            }
            catch (error) {
                reject(error)
            }
        })
    }
}

