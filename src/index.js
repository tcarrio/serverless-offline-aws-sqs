// FIXME: Remove the eslint disable
/* eslint-disable @typescript-eslint/no-var-requires */
const { join } = require("path");
const figures = require("figures");
const SQS = require("aws-sdk/clients/sqs");
const {
  mapValues,
  isEmpty,
  forEach,
  map,
  has,
  filter,
  get,
  pipe,
} = require("lodash/fp");
const {
  createHandler,
  getFunctionOptions,
} = require("serverless-offline/src/functionHelper");
const createLambdaContext = require("serverless-offline/src/createLambdaContext");

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

const getConfig = (service, pluginName) => {
  return (service && service.custom && service.custom[pluginName]) || {};
};

const extractQueueNameFromARN = arn => {
  const [, , , , , QueueName] = arn.split(":");
  return QueueName;
};

class ServerlessOfflineSQS {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.config = getConfig(this.service, "serverless-offline-aws-sqs");

    this.serverless.cli.log("found SQS config:");
    this.serverless.cli.log(JSON.stringify(this.config, null, 2));

    this.commands = {};

    this.hooks = {
      "before:offline:start:init": this.offlineStartInit.bind(this),
      "before:offline:start:end": this.offlineStartEnd.bind(this),
    };

    this.streams = [];
  }

  getClient() {
    const awsConfig = Object.assign(
      {
        region:
          this.options.region || this.service.provider.region || "us-east-1",
      },
      this.config,
    );
    this.serverless.cli.log("getClient with config:");
    this.serverless.cli.log(JSON.stringify(awsConfig, null, 2));
    const awsSqs = new SQS(awsConfig);
    this.serverless.cli.log(`generated SQS with endpoint ${awsSqs.endpoint}`);
    return awsSqs;
  }

  getQueueName(queueEvent) {
    if (typeof queueEvent === "string")
      return extractQueueNameFromARN(queueEvent);
    if (typeof queueEvent.arn === "string")
      return extractQueueNameFromARN(queueEvent.arn);
    if (typeof queueEvent.queueName === "string") return queueEvent.queueName;

    if (queueEvent.arn["Fn::GetAtt"]) {
      const [ResourceName] = queueEvent.arn["Fn::GetAtt"];
      const resource = this.getReferencedQueuesName(ResourceName);
      if (resource) {
        return resource;
      }
    }

    throw new Error(`QueueName not found. See Readme`);
  }

  eventHandler(queueEvent, functionName, messages, cb) {
    if (!messages) return cb();

    const streamName = this.getQueueName(queueEvent);
    this.serverless.cli.log(`${streamName} (λ: ${functionName})`);
    let location = "";
    const offlinePlugin = this.serverless.pluginManager
      .getPlugins()
      .find(p => p.constructor && p.constructor.name === "Offline");
    if (offlinePlugin) {
      location = offlinePlugin.options.location;
    }

    const __function = this.service.getFunction(functionName);

    const { env } = process;
    const providerEnv = this.dereferencedObject(
      "service.provider.environment",
      this,
    );
    const environment = this.dereferencedObject("environment", __function);
    const functionEnv = Object.assign({}, env, providerEnv, environment);
    process.env = functionEnv;

    const servicePath = join(this.serverless.config.servicePath, location);
    const funcOptions = getFunctionOptions(
      __function,
      functionName,
      servicePath,
    );
    const handler = createHandler(
      funcOptions,
      Object.assign({}, this.options, this.config),
    );

    const lambdaContext = createLambdaContext(__function, (err, data) => {
      this.serverless.cli.log(
        `[${err ? figures.cross : figures.tick}] ${JSON.stringify(data) || ""}`,
      );
      cb(err, data);
    });

    const event = {
      Records: messages.map(
        ({
          MessageId: messageId,
          ReceiptHandle: receiptHandle,
          Body: body,
          Attributes: attributes,
          MessageAttributes: messageAttributes,
          MD5OfBody: md5OfBody,
        }) => ({
          messageId,
          receiptHandle,
          body,
          attributes,
          messageAttributes,
          md5OfBody,
          eventSource: "aws:sqs",
          eventSourceARN: queueEvent.arn,
          awsRegion: "us-east-1",
        }),
      ),
    };

    if (handler.length < 3) {
      handler(event, lambdaContext)
        .then(res => lambdaContext.done(null, res))
        .catch(lambdaContext.done);
    } else {
      handler(event, lambdaContext, lambdaContext.done);
    }

    process.env = env;
  }

  async createQueueReadable(functionName, queueEvent) {
    this.serverless.cli.log("Entered createQueueReadable");
    const client = await this.getClient();
    const queueName = this.getQueueName(queueEvent);

    this.serverless.cli.log(`QueueName is ${queueName}`);

    let { QueueUrl } = await fromCallback(cb =>
      client.getQueueUrl(
        {
          QueueName: queueName,
        },
        cb,
      ),
    );

    if (!QueueUrl.includes(client.endpoint)) {
      this.serverless.cli.log("QueueUrl does not contain the correct host");
      this.serverless.cli.log(`Found: ${QueueUrl}`);
      QueueUrl = QueueUrl.replace(
        /^https?:\/\/(localhost|127.0.0.1):\d+/,
        client.config.endpoint,
      );
    }

    this.serverless.cli.log(`QueueUrl is ${QueueUrl}`);

    const next = async () => {
      const { Messages } = await fromCallback(cb =>
        client.receiveMessage(
          {
            QueueUrl,
            MaxNumberOfMessages: queueEvent.batchSize,
            AttributeNames: ["All"],
            MessageAttributeNames: ["All"],
            WaitTimeSeconds: 1,
          },
          cb,
        ),
      );

      if (Messages) {
        await fromCallback(cb =>
          this.eventHandler(queueEvent, functionName, Messages, cb),
        );

        await fromCallback(cb =>
          client.deleteMessageBatch(
            {
              Entries: (Messages || []).map(
                ({ MessageId: Id, ReceiptHandle }) => ({
                  Id,
                  ReceiptHandle,
                }),
              ),
              QueueUrl,
            },
            () => cb(),
          ),
        );
      }

      next();
    };

    next();
  }

  async createInitialQueue(queue) {
    this.serverless.cli.log(`Creating queue: ${queue.QueueName}`);
    return new Promise(async (resolve, reject) => {
      const client = await this.getClient();

      const params = {
        QueueName: queue.QueueName /* required */,
        Attributes: {},
      };

      forEach(attribute => {
        if (attribute !== "QueueName") {
          params.Attributes = {
            ...params.Attributes,
            ...JSON.stringify(attribute, queue[attribute]),
          };
        }
      }, Object.keys(queue));

      client.createQueue(params, err => {
        if (err) reject(err);
        resolve();
      });
    });
  }

  async offlineStartInit() {
    this.serverless.cli.log(`Creating Offline SQS Queues.`);
    if (
      this.service &&
      this.service.resources &&
      this.service.resources.Resources
    ) {
      const resources = Object.keys(this.service.resources.Resources);
      const queues = resources.filter(
        r => this.service.resources.Resources[r].Type === "AWS::SQS::Queue",
      );
      const parentResources = queues
        .filter(
          r =>
            !this.referencesArn(this.service.resources.Resources[r].Properties),
        )
        .map(r => this.service.resources.Resources[r].Properties);
      const childResources = queues
        .filter(
          r =>
            !!this.referencesArn(
              this.service.resources.Resources[r].Properties,
            ),
        )
        .map(r => this.service.resources.Resources[r].Properties);

      // NOTE: In case of a parent-child reference in the SQS declarations, this
      // allows for the dependencies to be created prior to the dependents. This
      // also does not handle cases where references go multiple levels deep.
      await Promise.all(parentResources.map(q => this.createInitialQueue(q)));
      printBlankLine();
      await Promise.all(childResources.map(q => this.createInitialQueue(q)));
      printBlankLine();
    }

    this.serverless.cli.log(`Starting Offline SQS.`);

    const readableQueuePromises = [];

    mapValues.convert({ cap: false })((_function, functionName) => {
      const queues = pipe(
        get("events"),
        filter(has("sqs")),
        map(get("sqs")),
      )(_function);

      this.serverless.cli.log(
        `${functionName} has ${queues.length} events from SQS`,
      );

      if (!isEmpty(queues)) {
        printBlankLine();
        this.serverless.cli.log(`SQS for ${functionName}:`);
      }

      forEach(queueEvent => {
        readableQueuePromises.push(
          this.createQueueReadable(functionName, queueEvent),
        );
      }, queues);

      if (!isEmpty(queues)) {
        printBlankLine();
      }
    }, this.service.functions);

    await Promise.all(readableQueuePromises);
  }

  offlineStartEnd() {
    this.serverless.cli.log("offline-start-end");
  }

  referencesArn(resource) {
    return (
      resource.RedrivePolicy &&
      resource.RedrivePolicy.deadLetterTargetArn &&
      resource.RedrivePolicy.deadLetterTargetArn["Fn:GetAtt"] &&
      this.names.has(resource.RedrivePolicy.deadLetterTargetArn["Fn:GetAtt"][0])
    );
  }

  dereferencedObject(key, ref) {
    const input = get(key, ref) || {};

    const nonreferencedObj = Object.keys(input)
      .filter(k => input[k].Ref === undefined)
      .reduce((o, k) => ({ ...o, [k]: input[k] }), {});

    const dereferencedObj = Object.keys(input)
      .filter(k => input[k].Ref !== undefined)
      .reduce(
        (o, k) => ({
          ...o,
          [k]: this.getReferencedQueuesName(input[k].Ref),
        }),
        {},
      );

    return {
      ...nonreferencedObj,
      ...dereferencedObj,
    };
  }

  getReferencedQueuesName(name) {
    const queueName = get(
      `service.resources.Resources.${name}.Properties.QueueName`,
      this,
    );
    if (queueName) {
      return queueName;
    } else {
      this.serverless.cli.log(
        "Failed to retrieve reference name from service listing",
      );
      this.serverless.cli.log(this.service.resources);
    }

    return null;
  }
}

module.exports = ServerlessOfflineSQS;
