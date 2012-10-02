/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This file contains all the VM logic, used to communicate with the server
 * with the intent of manipulating and interacting with VMs.
 */

var async = require('async');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var ModelBase = require('./base');
var ModelServer;

// console.log("MODEL SERVER IS FUCKING %s", util.inspect(ModelServer));
// console.dir(ModelServer);

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

ModelVM.init = function (model) {
    ModelServer = require('./server');
    this.model = model;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelVM[p] = ModelBase.staticFn[p];
    });

    ModelVM.log = model.getLog();
};


/**
 * Look up a VM's information via a provsioner task. (Synchronous, does not
 * return until request completes.)
 */
ModelVM.prototype.load = function (callback) {
    var self = this;

    ModelVM.getTaskClient().getAgentHandle(
        PROVISIONER,
        self.serverUuid,
        function (handle) {
            handle.sendTask(
                'machine_load',
                { uuid: self.uuid },
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

function createTaskCallback(req, res, next) {
    return function (error, task_id) {
        res.send({ id: task_id });
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

    req.log.info({server: server.uuid, task: task, params: req.params},
        'send provisioner task');
    server.sendProvisionerTask(
        task,
        req.params,
        ModelServer.createProvisionerEventHandler(self, req.params.jobid),
        createTaskCallback(req, res, next));
};

module.exports = ModelVM;
