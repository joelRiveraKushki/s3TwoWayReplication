# Serverless S3 two way replication plugin

This is a serverless plugin to easily setup two way replications between AWS S3 buckets.

The plugin will wait until all buckets from the configuration exist. If they all succeed, the plugin will modify the configured S3 buckets and add replication to them. Also, the required IAM roles will automatically be created for you. 

## Install
`npm install --save-dev serverless-s3-two-way-replication-plugin`

## Usage
1. Configure the plugin in your `serverless.yml`

```yaml
plugins:
- serverless-s3-two-way-replication-plugin
```
2. Add the configuration for the plugin

```yaml
custom:
  s3TwoWayReplicationPlugin:
    twoWayReplication:
      - mainBucket:
          us-east-1: my-bucket-us-east-1
        replicationBucket:
          us-west-2: my-bucket-us-west-2
      - mainBucket:
          us-central-1: my-bucket-us-central-1
        replicationBucket:
          us-west-1: my-bucket-us-west-1
```