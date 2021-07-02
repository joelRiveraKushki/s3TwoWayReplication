const chalk = require("chalk");
const aws = require("aws-sdk");

const S3_PREFIX = "arn:aws:s3:::";
const TAG = "S3-TWO-WAY-REPLICATION-PLUGIN";
const LOG_PREFIX = "S3-TWO-WAY-REPLICATION-PLUGIN";

async function getAccountId() {
  const sts = new aws.STS();
  const identity = await sts.getCallerIdentity().promise();
  return identity.Account;
}

function getServiceName(serverless) {
  return serverless.service.getServiceName();
}

function getTwoWayReplicationConfigs(serverless) {
  return serverless.service.custom.s3TwoWayReplicationPlugin.twoWayReplication;
}

async function setupS3Replication(serverless) {
  serverless.cli.log(`${LOG_PREFIX} Starting setting up the S3 Replication`);
  const replicationConfigMap = new Map();

  if (await allSpecifiedBucketsExist(serverless)) {
    if (getTwoWayReplicationConfigs(serverless)) {
      setupTwoWayReplicationBuckets(serverless, replicationConfigMap);
    }

    await createReplicationRoleForEachBucket(serverless, replicationConfigMap);
    await putBucketReplicationsForReplicationConfigMap(
      serverless,
      replicationConfigMap
    );
  }
  serverless.cli.log(`${LOG_PREFIX} Finished S3 replication plugin`);

  return replicationConfigMap;
}

function setupTwoWayReplicationBuckets(serverless, replicationConfigMap) {
  serverless.cli.log(
    `${LOG_PREFIX} Starting setup of bidirectional replication buckets`
  );

  for (const twoWayReplicationConfig of getTwoWayReplicationConfigs(
    serverless
  )) {
    const mainBucketConfig = twoWayReplicationConfig.mainBucket;
    const mainRegion = getRegion(mainBucketConfig);
    const mainBucketName = getBucketName(mainBucketConfig);
    const replicationBucketConfig = twoWayReplicationConfig.replicationBucket;

    setupReplicationConfigForMainAndReplicationBuckets(
      serverless,
      replicationConfigMap,
      mainBucketName,
      replicationBucketConfig,
      mainRegion
    );
  }
}

function setupReplicationConfigForMainAndReplicationBuckets(
  serverless,
  replicationConfigMap,
  mainBucket,
  replicationBucketConfig,
  mainRegion
) {
  const replicationConfigMainBucket = {
    rules: createS3RulesForBucket(
      serverless,
      mainBucket,
      replicationBucketConfig
    ),
    targetBucketConfigs: replicationBucketConfig,
    region: mainRegion,
  };

  replicationConfigMap.set(mainBucket, replicationConfigMainBucket);
}

async function createOrUpdateS3ReplicationRole(
  serverless,
  mainBucket,
  replicationBucketConfigs,
  mainRegion
) {
  const iam = new aws.IAM();

  const roleName = `${getServiceName(
    serverless
  )}-${mainRegion}-s3-rep-role`;

  const createRoleRequest = {
    RoleName: roleName,
    AssumeRolePolicyDocument: getAssumeRolePolicyDocument(),
    Tags: [
      {
        Key: TAG,
        Value: TAG,
      },
    ],
  };

  try {
    await iam.createRole(createRoleRequest).promise();
  } catch (e) {
    if (e.code !== "EntityAlreadyExists") throw e;
  }

  const putRolePolicyRequest = {
    RoleName: roleName,
    PolicyName: "s3-replication-policy",
    PolicyDocument: getPolicyDocument(mainBucket, replicationBucketConfigs),
  };

  await iam.putRolePolicy(putRolePolicyRequest).promise();

  return roleName;
}

function getPolicyDocument(sourceBucket, targetBucketConfigs) {
  const targetBucketArns = [];

  for (const targetBucketConfig of targetBucketConfigs) {
    targetBucketArns.push(`${S3_PREFIX}${getBucketName(targetBucketConfig)}/*`);
  }

  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetReplicationConfiguration", "s3:ListBucket"],
        Resource: [`${S3_PREFIX}${sourceBucket}`],
      },
      {
        Effect: "Allow",
        Action: [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging",
        ],
        Resource: [`${S3_PREFIX}${sourceBucket}/*`],
      },
      {
        Effect: "Allow",
        Action: [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags",
        ],
        Resource: targetBucketArns,
      },
    ],
  });
}

function getAssumeRolePolicyDocument() {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Service: ["s3.amazonaws.com"],
        },
        Action: ["sts:AssumeRole"],
      },
    ],
  });
}

async function putBucketReplicationsForReplicationConfigMap(
  serverless,
  replicationConfigMap
) {
  const s3 = new aws.S3();

  for (const mainBucket of replicationConfigMap.keys()) {
    const mainReplicationConfig = replicationConfigMap.get(mainBucket);
    const s3BucketReplicationRequest = {
      Bucket: mainBucket,
      ReplicationConfiguration: {
        Role: `arn:aws:iam::${await getAccountId()}:role/${
          mainReplicationConfig.role
        }`,
        Rules: mainReplicationConfig.rules,
      },
    };

    await s3.putBucketReplication(s3BucketReplicationRequest).promise();
  }
}

async function createReplicationRoleForEachBucket(
  serverless,
  replicationConfigMap
) {
  for (const mainBucket of replicationConfigMap.keys()) {
    const mainReplicationConfig = replicationConfigMap.get(mainBucket);
    mainReplicationConfig.role = await createOrUpdateS3ReplicationRole(
      serverless,
      mainBucket,
      mainReplicationConfig.targetBucketConfigs,
      mainReplicationConfig.region
    );
    replicationConfigMap.set(mainBucket, mainReplicationConfig);
  }
}

function createS3RulesForBucket(
  serverless,
  mainBucket,
  replicationBucketConfig,
  currentRules
) {
  const rules = currentRules || [];

  let counter = rules.length;

  const targetBucket = getBucketName(replicationBucketConfig);
  rules.push({
    Destination: {
      Bucket: `${S3_PREFIX}${targetBucket}`,
    },
    Status: "Enabled",
    Priority: counter,
    Filter: {
      Prefix: "",
    },
    DeleteMarkerReplication: {
      Status: "Enabled",
    },
  });

  serverless.cli.log(
    `${LOG_PREFIX} Creating replication rule between ${chalk.green(
      mainBucket
    )} and ${chalk.green(targetBucket)}`
  );
  return rules;
}

async function allSpecifiedBucketsExist(serverless) {
  let allBucketsExist = true;

  if (getTwoWayReplicationConfigs(serverless)) {
    for (const twoWayReplicationConfig of getTwoWayReplicationConfigs(
      serverless
    )) {
      const mainBucket = getBucketName(twoWayReplicationConfig.mainBucket);
      if (!(await validateBucketExists(serverless, mainBucket)))
        allBucketsExist = false;

      const replicationBucket = getBucketName(
        twoWayReplicationConfig.replicationBucket
      );
      if (!(await validateBucketExists(serverless, replicationBucket)))
        allBucketsExist = false;
    }
  }

  return allBucketsExist;
}

async function validateBucketExists(serverless, bucketName) {
  const s3 = new aws.S3();

  try {
    await s3
      .headBucket({
        Bucket: bucketName,
        ExpectedBucketOwner: `${await getAccountId()}`,
      })
      .promise();
  } catch (e) {
    if (e.code === "NotFound") {
      serverless.cli.log(
        `${LOG_PREFIX} ${chalk.red(
          `Bucket ${bucketName} does not exist yet. Plugin will only be executed when all buckets exist`
        )}`
      );

      return false;
    }
    throw e;
  }
  return true;
}

function getBucketName(bucketConfig) {
  return Object.values(bucketConfig)[0];
}

function getRegion(bucketConfig) {
  return Object.keys(bucketConfig)[0];
}

module.exports = {
  setupS3Replication,
};
