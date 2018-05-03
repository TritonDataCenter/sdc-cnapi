/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var async = require('async');
var common = require('../../lib/common');
var path = require('path');
var App = require('../../lib/app');

var configFilename = path.join(__dirname, '..', '..', 'config', 'test.json');
var mockedMetricsManager = {
    collectRestifyMetrics: function _collectRestifyMetrics() {}
};

var MockLogger = {
    child: function _child() {
        return MockLogger;
    },
    debug: function _debug() {
    },
    error: function _error() {
    },
    info: function _info() {
    },
    trace: function _trace() {
    },
    warn: function _warn() {
    }
};


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
    this.results = [];
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

MockMoray.prototype._findObjectsResults = function (list) {
    var self = this;
    self.results.push(list);
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
    var self = this;
    this.history.push(['findObjects', bucket, filter, opts]);
    var req = new process.EventEmitter();
    this.reqs.push(req);
    var results = self.results.shift();
    process.nextTick(function () {
        results.forEach(function (i) {
            req.emit('record', { value: i });
        });
        req.emit('end');
    });
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
                dapi: config.dapi,
                amqp: {
                    host: 'localhost'
                }
            }, {
                log: MockLogger,
                metricsManager: mockedMetricsManager
            });
            app.setMoray(moray);
            app.setWorkflow(wf);
            app.setUr(ur);
            cb();
        }
    ],
    function (error) {
        var components = {
            moray: moray,
            workflow: wf,
            ur: ur
        };
        return callback(error, app, components);
    });
}

module.exports = {
    MockMorayWrapper: MockMorayWrapper,
    MockWorkflowWrapper: MockWorkflowWrapper,
    newApp: newApp
};
