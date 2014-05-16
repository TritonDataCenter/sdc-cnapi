/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This file contains all the VM logic, used to communicate with the server
 * with the intent of manipulating and interacting with VMs.
 */

var async = require('async');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var nodeuuid = require('node-uuid');

var ModelBase = require('./base');
var ModelServer;

var PROVISIONER = 'provisioner';

function ModelVM(params) {
    var serverUuid = params.serverUuid;
    var uuid = params.uuid;

    if (!serverUuid) {
        throw new Error('ModelVM missing server_uuid parameter');
    }

    if (!uuid) {
        throw new Error('ModelVM missing uuid parameter');
    }

    this.uuid = uuid;
    this.serverUuid = serverUuid;

    this.log = ModelVM.getLog();
}

ModelVM.init = function (app) {
    ModelServer = require('./server');
    this.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelVM[p] = ModelBase.staticFn[p];
    });

    ModelVM.log = app.getLog();
};


/**
 * Look up a VM's information via a provsioner task. (Synchronous, does not
 * return until request completes.)
 */
ModelVM.prototype.load = function (opts, callback) {
    var self = this;
    var server = new ModelServer(self.serverUuid);

    var request = {
        task: 'machine_load',
        cb: function (error, task) {
        },
        evcb: function () {},
        synccb: function (error, result) {
            callback(error, result);
        },
        req_id: opts.req_id,
        params: { uuid: self.uuid }
    };

    server.sendTaskRequest(request);
};


/**
 * Look up a VM's vmadm info output via a provsioner task. (Synchronous, does
 * not return until request completes.)
 */

ModelVM.prototype.info = function (opts, callback) {
    var self = this;
    var server = new ModelServer(self.serverUuid);

    var request = {
        task: 'machine_info',
        cb: function (error, task) {
        },
        evcb: function () {},
        synccb: function (error, result) {
            callback(error, result);
        },
        req_id: opts.req_id,
        params: { uuid: self.uuid, types: opts.types }
    };

    server.sendTaskRequest(request);
};


function createTaskCallback(req, res, next) {
    return function (error, task) {
        res.send({ id: task.id });
        return next();
    };
}

/**
 * Execute a provisioner task against a VM on a server, optionally ensuring
 * that the VM exists prior to executing.
 */
ModelVM.prototype.performVmTask = function (task, checkExists, req, res, next) {
    var self = this;

    var server = new ModelServer(this.serverUuid);

    req.log.debug({server: server.uuid, task: task, params: req.params},
        'sending vm provisioner task');
    server.sendTaskRequest({
        task: task,
        params: req.params,
        req: req,
        evcb: ModelServer.createProvisionerEventHandler(self, req.params.jobid),
        cb: createTaskCallback(req, res, next)
    });
};

module.exports = ModelVM;
