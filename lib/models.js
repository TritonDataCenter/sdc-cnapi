/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This is where the core of CNAPI abstractions and logic is defined:
 * - caching
 * - interacting with workflows
 * - communicating with servers
 */

var TaskClient = require('task_agent/lib/client');
var WorkflowClient = require('wf-client');
var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var execFile = require('child_process').execFile;
var fs = require('fs');
var restify = require('restify');
var util = require('util');
var sprintf = require('sprintf').sprintf;

var common = require('./common');

var Redis = require('./apis/redis');
var Workflow = require('./apis/workflow');
var Moray = require('./apis/moray');
var buckets = require('./apis/moray').BUCKETS;

var ModelBase = require('./models/base');
var ModelPlatform = require('./models/platform');
var ModelServer = require('./models/server');
var ModelVM = require('./models/vm');
var verror = require('verror');


function Model(config) {
    this.config = config;
    this.log = config.log;
    this.tasks = {};
    this.connectionStatus = {};

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
            self.morayClientCreate(cb);
        },
        function (cb) {
            self.workflowClientCreate(cb);
        },
        function (cb) {
            self.moray.getClient(cb);
        },
        function (cb) {
            self.redis.getClient(cb);
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


Model.prototype.initializeBuckets = function (callback) {
    var self = this;
    var moray = this.moray.getClient();

    self.log.info('Initializing buckets');
    async.waterfall([
        function (cb) {
            self.moray.ensureClientReady(cb);
        },
        function (cb) {
            moray.getBucket(buckets.servers.name, function (error, bucket) {
                if (error) {
                    if (error.name === 'BucketNotFoundError') {
                        self.log.info(
                            'Moray bucket \'%s\', does not yet exist. Creating'
                            + ' it.', buckets.servers.name);
                        moray.createBucket(
                            buckets.servers.name, buckets.servers.bucket, cb);
                        return;
                    } else {
                        self.log.info(
                            'Moray bucket error, %s, exists.', error.message);
                        cb(error);
                        return;
                    }
                }

                cb();
            });
        },
        function (cb) {
            // Check for 'default' server object
            moray.getObject(
                buckets.servers.name,
                'default',
                function (error, obj) {
                    if (error) {

                        if (error.name === 'ObjectNotFoundError') {
                            self.log.info(
                                'Default object does not yet exist, creating'
                                + ' it now.');
                            ModelServer.setDefaultServer(cb);
                        } else {
                            self.log.warn(error);
                            cb(error);
                            return;
                        }
                    } else {
                        cb();
                    }
                });
        }
    ], callback);
};


Model.prototype.redisClientCreate = function (callback) {
    this.redis = new Redis({
        log: this.log,
        config: this.config.redis
    });
    callback();
};

Model.prototype.morayClientCreate = function (callback) {
    this.moray = new Moray({
        log: this.log,
        config: this.config
    });
    callback();
};

Model.prototype.workflowClientCreate = function (callback) {
    var self = this;
    var config = {
        workflows: [
            'server-setup',
            'server-factory-reset',
            'server-sysinfo',
            'server-reboot',
            'server-update-nics'
        ],
        url: self.config.wfapi.url,
        log: this.log,
        path: __dirname + '/workflows',

        forceReplace: true
    };

    this.workflow = new Workflow({
        config: config,
        log: this.log
    });

    this.workflow.startAvailabilityWatcher();

    // Don't proceed with initializing workflows until we have connected.
    async.until(
        function () { return self.workflow.connected; },
        function (cb) {
            setTimeout(cb, 1000);
        },
        function () {
            self.workflow.getClient().initWorkflows(function (error) {
                if (error) {
                    self.log.error(error, 'Error initializing workflows');
                }
            });
        });

    callback();
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
    return this.moray.getClient();
};

Model.prototype.setMoray = function (moray) {
    this.moray = moray;
    return this.moray;
};


/**
 * Workflow
 */

Model.prototype.getWorkflow = function () {
    return this.workflow;
};

Model.prototype.setWorkflow = function (workflow) {
    this.workflow = workflow;
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
