var async = require('async');
var common = require('../../lib/common');
var path = require('path');
var App = require('../../lib/app');

var configFilename = path.join(__dirname, '..', '..', 'config', 'test.json');

/**
 *
 * Moray
 *
 */

function MockMoray() {
    this.history = [];
    this.callbackValues = {
        putObject: [],
        findObjects: [],
        getObjects: [],
        delObject: []
    };
    this.reqs = [];
}

MockMoray.prototype.when = function (fn, args, results) {
    if (!this.callbackValues[fn]) {
        this.callbackValues[fn] = [];
    }
    this.callbackValues[fn].push(results);
};

MockMoray.prototype._emitResults = function (list) {
    var self = this;
    list.forEach(function (i) {
        self._lastReq().emit('record', { value: i });
    });
    self._lastReq().emit('end');
};

MockMoray.prototype._lastReq = function () {
    return this.reqs[this.reqs.length-1];
};

MockMoray.prototype.getObject = function (bucket, key, callback) {
    this.history.push(['getObject', bucket, key]);
    var val = this.callbackValues.getObject.pop();
    callback.apply(null, [ null, val ]);
    return this;
};

MockMoray.prototype.putObject = function (bucket, key, value, callback) {
    this.history.push(['putObject', bucket, key, value]);
    callback.apply(null, [ null ]);
    return this;
};

MockMoray.prototype.delObject = function (bucket, key, callback) {
    this.history.push(['delObject', bucket, key]);
    callback.apply(null, [ null ]);
    return this;
};

MockMoray.prototype.findObjects = function (bucket, filter, opts) {
    this.history.push(['findObjects', bucket, filter, opts]);
    var req = new process.EventEmitter();
    this.reqs.push(req);
    return req;
};

function MockMorayWrapper() {
    this.client = new MockMoray();
}

MockMorayWrapper.prototype.getClient = function () {
    return this.client;
};

/**
 *
 * Workflow
 *
 */

function MockWorkflow() {
    this.history = [];
    this.callbackValues = {
        createJob: []
    };
}

MockWorkflow.prototype.when = function (fn, args, results) {
    if (!this.callbackValues[fn]) {
        this.callbackValues[fn] = [];
    }
    this.callbackValues[fn].push(results);
};

MockWorkflow.prototype.createJob = function (workflowName, params, callback) {
    this.history.push(['createJob', workflowName, params ]);

    var job = {
        uuid: '1234b888-f8e0-11e1-b1a8-5f74056f9365'
    };

    callback(null, job);
    return this;
};

function MockWorkflowWrapper() {
    this.client = new MockWorkflow();
}

MockWorkflowWrapper.prototype.getClient = function () {
    return this.client;
};

/**
 *
 * Redis
 *
 */

function MockRedis() {
    this.history = [];
    this.callbackValues = {
        get: [],
        del: [],
        hmset: [],
        hmgetall: [],
        exec: [],
        exists: [],
        keys: []
    };
}

MockRedis.prototype.when = function (fn, args, results) {
    if (!this.callbackValues[fn]) {
        this.callbackValues[fn] = [];
    }
    this.callbackValues[fn].push(results);
};

MockRedis.prototype.hmset = function (key, values, callback) {
    this.history.push(['hmset', key, values]);
    callback();
    return this;
};

MockRedis.prototype.hgetall = function (key, callback) {
    this.history.push(['hgetall', key]);
    callback();
    return this;
};

MockRedis.prototype.get = function (key, callback) {
    this.history.push(['get', key]);
    callback();
    return this;
};

MockRedis.prototype.keys = function (key, callback) {
    this.history.push(['keys', key]);
    callback.apply(null, this.callbackValues.keys.pop());
    return this;
};

MockRedis.prototype.del = function (key, callback) {
    this.history.push(['del', key]);
    callback();
    return this;
};

function MockRedisWrapper() {
    this.client = new MockRedis();
}

MockRedisWrapper.prototype.getClient = function () {
    return this.client;
};

/**
 *
 * Ur
 *
 */

function MockUr() {
    this.history = [];
    this.callbackValues = {
        execute: []
    };
}

MockUr.prototype.when = function (fn, args, results) {
    if (!this.callbackValues[fn]) {
        this.callbackValues[fn] = [];
    }
    this.callbackValues[fn].push(results);
};


MockUr.prototype.execute = function (opts, callback) {
    this.history.push(['execute', opts]);
    callback.apply(null, this.callbackValues.execute.pop());
    return this;
};


function newApp(callback) {
    var config;
    var app;

    var moray = new MockMorayWrapper();
    var redis = new MockRedisWrapper();
    var wf = new MockWorkflowWrapper();
    var ur = new MockUr();

    async.waterfall([
        function (cb) {
            common.loadConfig(configFilename, function (error, c) {
                config = c;
                return cb();
            });
        },
        function (cb) {
            app = new App({
                logLevel: 'info',
                datacenter: config.datacenter_name,
                cnapi: config.cnapi,
                amqp: {
                    host: 'localhost'
                }
            });
            app.setMoray(moray);
            app.setRedis(redis);
            app.setWorkflow(wf);
            app.setUr(ur);
            cb();
        }
    ],
    function (error) {
        var components = {
            moray: moray,
            redis: redis,
            workflow: wf,
            ur: ur
        };
        return callback(error, app, components);
    });
}

module.exports = {
    MockRedis: MockRedis,
    MockRedisWrapper: MockRedisWrapper,
    MockMorayWrapper: MockMorayWrapper,
    MockWorkflowWrapper: MockWorkflowWrapper,
    newApp: newApp
};
