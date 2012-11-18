/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This is where the core of CNAPI abstractions and logic is defined:
 * - caching
 * - interacting with workflows
 * - communicating with servers
 */

var async = require('async');
var assert = require('assert-plus');
var util = require('util');
var TaskClient = require('task_agent/lib/client');
var sprintf = require('sprintf').sprintf;
var common = require('./common');
var execFile = require('child_process').execFile;
var fs = require('fs');
var restify = require('restify');
var Redis = require('./redis_client');
var WorkflowClient = require('wf-client');
var bunyan = require('bunyan');
var moray_client = require('moray');
var buckets = require('./moray/buckets');

var ModelBase = require('./models/base');
var ModelPlatform = require('./models/platform');
var ModelServer = require('./models/server');
var ModelVM = require('./models/vm');

var SUFFIX = 'o=smartdc';
var SERVERS = 'ou=servers, datacenter=%s, ' + SUFFIX;
var SERVER_FMT = 'uuid=%s,' + SERVERS;

var PROVISIONER = 'provisioner';

function Model(config) {
    this.config = config;
    this.log = config.log;
    this.tasks = {};

    ModelBase.init(this);
    ModelPlatform.init(this);
    ModelServer.init(this);
    ModelVM.init(this);
}

Model.prototype.initialize = function (callback) {
    this.initializeBuckets(callback);
};

/**
 * Connect the model instance to storange and API backends.
 */
Model.prototype.connect = function (callback) {
    var self = this;

    async.waterfall([
        function (cb) {
            self.redisClientCreate(cb);
        },
        function (cb) {
            self.taskClientCreate(cb);
        },
        function (cb) {
            self.createClientMoray(cb);
        },
        function (cb) {
            self.workflowClientCreate(cb);
        }
    ],
    function (error) {
        if (error) {
            self.log.error(error);
            return callback(error);
        }
        self.log.debug('Model connected');
        return callback();
    });
};

/**
 * Disconnect model instance from storage and API backends.
 */
Model.prototype.disconnect = function (callback) {
    this.taskClient.end();
};

/**
 * Pass in an AMQP connection object to be used by model.
 */
Model.prototype.useConnection = function (connection) {
    this.taskClient.useConnection(connection);
};

/**
 * Create a provisioner task client instance.
 */
Model.prototype.taskClientCreate = function (callback) {
    var self = this;
    this.taskClient = new TaskClient(self.config);
    callback();
};

/**
 * Connect the model instance to the Moray service.
 */
Model.prototype.createClientMoray = function (callback) {
    var self = this;

    assert.func(callback, 'callback');

    var client = self.moray = moray_client.createClient({
        host: self.config.moray.host,
        port: self.config.moray.port,
        log: bunyan.createLogger({
            name: 'moray',
            serializers: bunyan.stdSerializers
        }),
        connectTimeout: 10000,
        retry: {
            retries: Infinity,
            minTimeout: 1000,
            maxTimeout: 60000
        }
    });

    function onConnect() {
        client.removeListener('error', onError);
        self.log.info({moray: client.toString()}, 'moray: connected');

        client.on('close', function () {
            self.log.error('moray: closed');
        });

        client.on('connect', function () {
            self.log.info('moray: reconnected');
        });

        client.on('error', function (err) {
            self.log.warn(err, 'moray: error (reconnecting)');
        });

        callback();
    }

    function onError(err) {
        client.removeListener('connect', onConnect);
        self.log.error(err, 'moray: connection failed');
        setTimeout(self.createClientMoray.bind(self, callback), 1000);
    }

    function onConnectAttempt(number, delay) {
        var level;
        if (number === 0) {
            level = 'info';
        } else if (number < 5) {
            level = 'warn';
        } else {
            level = 'error';
        }
        self.log[level]({
            attempt: number,
            delay: delay
        }, 'moray: connection attempted');
    }

    client.once('connect', onConnect);
    client.once('error', onError);
    client.on('connectAttempt', onConnectAttempt); // this we always use
};


Model.prototype.initializeBuckets = function (callback) {
    var moray = this.moray;

    moray.getBucket(buckets.servers.name, function (error, bucket) {
        if (error) {
            if (error.name === 'BucketNotFoundError') {
                moray.createBucket(
                    buckets.servers.name, buckets.servers.bucket, callback);
                return;
            } else {
                callback(error);
                return;
            }
        }
        callback();
    });
};

Model.prototype.redisClientCreate = function (callback) {
    this.redis = new Redis({
        log: this.log,
        config: this.config.redis
    });
    callback();
};

Model.prototype.workflowClientCreate = function (callback) {
    var self = this;
    var config = {
        workflows: [
            'server-setup',
            'server-factory-reset',
            'server-sysinfo'
        ],
        url: self.config.wfapi.url,
        log: this.log,
        path: __dirname + '/workflows',

        forceReplace: true
    };

    this.workflow = new WorkflowClient(config);
    this.workflow.initWorkflows(callback);
};


/**
 * Redis
 */

Model.prototype.getRedis = function () {
    return this.redis.getClient();
};

Model.prototype.setRedis = function (redis) {
    this.redis = redis;
    return redis;
};


/**
 * Moray
 */

Model.prototype.getMoray = function () {
    return this.moray;
};

Model.prototype.setMoray = function (morayClient) {
    this.moray = morayClient;
    return this.moray;
};


/**
 * Workflow
 */

Model.prototype.getWorkflow = function () {
    return this.workflow;
};

/**
 * Task Client
 */

Model.prototype.getTaskClient = function () {
    return this.taskClient;
};


/**
 * Ur
 */

Model.prototype.getUr = function () {
    return this.ur;
};

Model.prototype.setUr = function (ur) {
    this.ur = ur;
    return ur;
};

/**
 * Misc
 */

Model.prototype.getLog = function () {
    return this.log;
};

Model.prototype.getConfig = function () {
    return this.config;
};


/**
 * Create and return a new Model object.
 */

function createModel(config) {
    return new Model(config);
}

module.exports = {
    createModel: createModel,
    Model: Model
};
