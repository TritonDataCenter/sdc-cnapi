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

var ModelServer = require('./models/server');
var ModelVM = require('./models/vm');
var ModelBase = require('./models/base');

var SUFFIX = 'o=smartdc';
var SERVERS = 'ou=servers, datacenter=%s, ' + SUFFIX;
var SERVER_FMT = 'uuid=%s,' + SERVERS;

var PROVISIONER = 'provisioner';

function Model(config) {
    this.config = config;
    this.log = config.log;
    this.tasks = {};

    ModelBase.init(this);
    ModelServer.init(this);
    ModelVM.init(this);
}


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


/**
 * Assign a UFDS connection object to be used by the model.
 */
Model.prototype.setUfds = function (ufds) {
    this.ufds = ufds;
    return ufds;
};


/**
 * Assign a Workflow API client object to be used by the model.
 */
Model.prototype.setWfapi = function (wfapi) {
    this.wfapi = wfapi;
    return wfapi;
};

Model.prototype.setUr = function (ur) {
    this.ur = ur;
    return ur;
};

Model.prototype.getRedis = function () {
    return this.redis.getClient();
};

Model.prototype.setRedis = function (redis) {
    this.redis = redis;
};

// XXX refactor to use this.workflow instead
Model.prototype.getWfapi = function () {
    return this.wfapi;
};

Model.prototype.getWorkflow = function () {
    return this.workflow;
};

Model.prototype.getTaskClient = function () {
    return this.taskClient;
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


Model.prototype.getUfds = function () {
    return this.ufds;
};


Model.prototype.getUr = function () {
    return this.ur;
};


Model.prototype.getLog = function () {
    return this.log;
};


Model.prototype.getConfig = function () {
    return this.config;
};


/**
 * Delete a Server from UFDS.
 */
Model.prototype.deleteServer = function (uuid, callback) {
    var self = this;

    var datacenter = self.config.datacenter;

    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
    var options = {};

    self.ufds.search(baseDn, options, function (error, items) {
        async.forEachSeries(
            items,
            function (item, fe$callback) {
                self.ufds.del(item.dn, function (fe$error) {
                    fe$callback();
                });
            },
            function (fe$error) {
                return callback(fe$error);
            });
    });
};

/**
 * Look up a VM's information via a provsioner task. (Synchronous, does not
 * return until request completes.)
 */
Model.prototype.loadVm = function (serverUuid, vmUuid, callback) {
    var self = this;

    self.taskClient.getAgentHandle(
        PROVISIONER,
        serverUuid,
        function (handle) {
            handle.sendTask(
                'machine_load',
                { uuid: vmUuid },
                function (taskHandle) {
                    var error;

                    taskHandle.on('event', function (eventName, msg) {
                        if (eventName === 'error') {
                            self.log.error(
                                'Error received during loadVm: %s',
                                msg.error);
                            error = msg.error;
                        } else if (eventName === 'finish') {
                            if (error) {
                                callback(new Error(error));
                                return;
                            } else {
                                callback(null, msg);
                                return;
                            }
                        }
                    });
                });
        });
};


Model.prototype.zfsTask = function (task, uuid, options, callback) {
    var self = this;

    self.log.info(options);

    self.taskClient.getAgentHandle(PROVISIONER, uuid,
    function (handle) {
        handle.sendTask(task, options,
            function (taskHandle) {
                var error;

                taskHandle.on('event', function (eventName, msg) {
                    if (eventName === 'error') {
                        self.log.error(
                            'Error received during loadVm: %s',
                            msg.error);
                        error = msg.error;
                    } else if (eventName === 'finish') {
                        if (error) {
                            return (callback(new Error(error)));
                        } else {
                            return (callback(null, msg));
                        }
                    }
                    return (null);
                });
        });
    });
};


/**
 * Execute a command on a particular server via Ur.
 */
Model.prototype.serverInvokeUrScript =
function (uuid, script, params, callback) {
    var self = this;

    var opts = {
        uuid: uuid,
        message: {
            type: 'script',
            script: script,
            args: params.args || [],
            env: params.env || {}
        }
    };
    self.log.info('Sending compute node %s script', uuid);

    self.ur.execute(opts, function (err, stdout, stderr) {
        if (err) {
            self.log.error('Error raised by ur when ' +
                'running script: ' + err.message);
        }

        return (callback(err, stdout, stderr));
    });
};

/**
 * Create and return a new Model object.
 */

function createModel(config) {
    return new Model(config);
}

exports.createModel = createModel;
exports.Model = Model;
