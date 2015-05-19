/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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

    ModelServer.get(self.serverUuid, function (err, servermodel) {
        var request = {
            persist: false,
            task: 'machine_load',
            cb: function (error, task) {
            },
            evcb: function () {},
            synccb: function (error, result) {
                callback(error, result);
            },
            req: opts.req,
            params: { uuid: self.uuid }
        };

        servermodel.sendTaskRequest(request);
    });
};


/**
 * Look up a VM's processes /proc output via a provsioner task. (Synchronous,
 * does not return until request completes.)
 */

ModelVM.prototype.proc = function (opts, callback) {
    var self = this;

    ModelServer.get(self.serverUuid, function (err, servermodel) {
        var request = {
            task: 'machine_proc',
            cb: function (error, task) {
            },
            evcb: function () {},
            synccb: function (error, result) {
                callback(error, result);
            },
            params: { uuid: self.uuid }
        };

        servermodel.sendTaskRequest(request);
    });
};


/**
 * Look up a VM's vmadm info output via a provsioner task. (Synchronous, does
 * not return until request completes.)
 */

ModelVM.prototype.info = function (opts, callback) {
    var self = this;

    ModelServer.get(self.serverUuid, function (err, servermodel) {
        var request = {
            task: 'machine_info',
            cb: function (error, task) {
            },
            evcb: function () {},
            synccb: function (error, result) {
                callback(error, result);
            },
            params: { uuid: self.uuid, types: opts.types }
        };

        servermodel.sendTaskRequest(request);
    });
};


ModelVM.prototype.dockerCopy = function (opts, callback) {
    var self = this;

    ModelServer.get(self.serverUuid, function (err, servermodel) {
        var request = {
            task: 'docker_copy',
            cb: function (error, task) {},
            evcb: function () {},
            synccb: function (error, result) {
                callback(error, result);
            },
            params: { uuid: self.uuid, payload: opts.payload }
        };

        servermodel.sendTaskRequest(request);
    });
};


ModelVM.prototype.dockerExec = function (opts, callback) {
    var self = this;

    ModelServer.get(self.serverUuid, function (err, servermodel, obj) {
        var request = {
            task: 'docker_exec',
            cb: function (error, task) {},
            evcb: function () {},
            synccb: function (error, stream) {
                callback(error, stream);
            },
            params: { uuid: self.uuid, command: opts.command }
        };

        servermodel.sendTaskRequest(request);
    });
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
ModelVM.prototype.performVmTask =
function (task, checkExists, req, res, next, synccb) {
    var self = this;

    ModelServer.get(self.serverUuid, function (err, servermodel) {
        req.log.debug({server: servermodel.uuid,
                       task: task, params: req.params},
                      'sending vm provisioner task');
        servermodel.sendTaskRequest({
            task: task,
            params: req.params,
            req: req,
            synccb: synccb,
            evcb: ModelServer.createProvisionerEventHandler(
                self, req.params.jobid),
            cb: createTaskCallback(req, res, next)
        });
    });
};

module.exports = ModelVM;
