const helper = require('./helper')

class S3ReplicationPlugin {
  constructor (serverless, options) {
    this.serverless = serverless
    this.options = options

    this.hooks = {
      'after:deploy:deploy': () => helper.setupS3Replication(serverless)
    }
  }
}

module.exports = S3ReplicationPlugin
