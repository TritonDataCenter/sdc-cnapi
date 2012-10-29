/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This is where the core of CNAPI abstractions and logic is defined:
 * - caching
 * - interacting with workflows
 * - communicating with servers
 */

var async = require('async');
var util = require('util');
var TaskClient = require('task_agent/lib/client');
var UFDS = require('sdc-clients').UFDS;
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
            self.ufdsClientConnect(cb);
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
    this.ufds.close(callback);
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
 * Connect the model instance to the UFDS service.
 */

Model.prototype.createClientMoray = function (callback) {
    var self = this;
    var morayTimeout;

    connect();

    function connect() {
        morayTimeout = setTimeout(function () {
            self.log.info('Reconnecting to Moray');
            self.log.info('Closing connection');

            self.moray.close();
            connect();
        });

        self.moray = moray_client.createClient({
            host: self.config.moray.host,
            port: self.config.moray.port,
            log: bunyan.createLogger({
                name: 'moray',
                level: 'INFO',
                stream: process.stdout,
                serializers: bunyan.stdSerializers
            })
        });

        self.moray.on('error', function (error) {
            clearTimeout(morayTimeout);
            self.log.info({ error: error }, 'Moray error');
            self.moray.close();
        });

        self.moray.on('connect', function () {
            self.log.info('Moray ready');
            clearTimeout(morayTimeout);
            callback();
        });
    }
};

/**
 * Connect the model instance to the UFDS service.
 */
Model.prototype.ufdsClientConnect = function (callback) {
    var self = this;
    var ufds;
    var ufdsTimeout;

    connect();

    function connect() {
        ufdsTimeout = setTimeout(function () {
            self.log.info('Reconnecting to UFDS');
            self.log.info('Closing connection');

            ufds.close(function () {
                self.log.info('Creating a new connection');
                connect();
            });
        }, 5000);

        ufds = self.setUfds(new UFDS(self.config.ufds));
        ufds.setLogLevel('trace');
        ufds.on('error', function (e) {
            self.log.error(e, 'There was a ufds error');
        });

        ufds.on('ready', function () {
            self.log.info('UFDS ready!');
            clearTimeout(ufdsTimeout);
            return callback();
        });
    }
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
 * UFDS
 */

Model.prototype.getUfds = function () {
    return this.ufds;
};

Model.prototype.setUfds = function (ufds) {
    this.ufds = ufds;
    return ufds;
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
