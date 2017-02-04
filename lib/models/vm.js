/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This file contains all the VM logic, used to communicate with the server
 * with the intent of manipulating and interacting with VMs.
 */

var async = require('async');
var assert = require('assert-plus');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var sdcClients = require('sdc-clients');

var ModelBase = require('./base');
var ModelServer;


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
 * Look up a VM's information via a cn-agent task. (Synchronous, does not
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
            req_id: opts.req_id,
            req: opts.req,
            params: { uuid: self.uuid }
        };

        servermodel.sendTaskRequest(request);
    });
};


/**
 * Look up a VM's processes /proc output via a cn-agent task. (Synchronous,
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
            req_id: opts.req_id,
            params: { uuid: self.uuid }
        };

        servermodel.sendTaskRequest(request);
    });
};


/**
 * Look up a VM's vmadm info output via a cn-agent task. (Synchronous, does
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
            req_id: opts.req_id,
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
            req_id: opts.req_id,
            params: {
                uuid: self.uuid,
                path: opts.path,
                mode: opts.mode,
                no_overwrite_dir: opts.no_overwrite_dir,
                payload: opts.payload
            }
        };

        servermodel.sendTaskRequest(request);
    });
};


ModelVM.prototype.dockerStats = function (opts, callback) {
    var self = this;

    ModelServer.get(self.serverUuid, function (err, servermodel) {
        var request = {
            task: 'docker_stats',
            cb: function (error, task) {},
            evcb: function () {},
            synccb: function (error, result) {
                callback(error, result);
            },
            req_id: opts.req_id,
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
            req_id: opts.req_id,
            params: { uuid: self.uuid, command: opts.command }
        };

        servermodel.sendTaskRequest(request);
    });
};


ModelVM.prototype.dockerBuild = function (opts, callback) {
    var self = this;

    ModelServer.get(self.serverUuid, function (err, servermodel) {
        var request = {
            task: 'docker_build',
            cb: function (error, task) {},
            evcb: function () {},
            synccb: function (error, result) {
                callback(error, result);
            },
            req_id: opts.req_id,
            params: { uuid: self.uuid, payload: opts.payload },
            log_params: opts.log_params
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
 * Execute a task on a VM on a server, optionally ensuring that the VM exists
 * prior to executing.
 */

ModelVM.prototype.performVmTask =
function (task, checkExists, req, res, next, synccb) {
    var self = this;

    ModelServer.get(self.serverUuid, function (err, servermodel) {
        req.log.debug({server: servermodel.uuid,
                       task: task, params: req.params},
                      'sending vm cn-agent task');
        servermodel.sendTaskRequest({
            task: task,
            params: req.params,
            req: req,
            synccb: synccb,
            evcb: ModelServer.createComputeNodeAgentHandler(
                self, req.params.jobid),
            cb: createTaskCallback(req, res, next)
        });
    });
};


/**
 * Fetch and return a list of VMs (and a subset of their fields) from VMAPI.
 */

ModelVM.listVmsViaVmapi =
function (opts, callback) {
    var self = this;

    assert.string(opts.server_uuid, 'opts.server_uuid');

    var vmapi = new sdcClients.VMAPI({
        url: self.app.config.vmapi.url,
        connectTimeout: 5000
    });

    var args = {
        server_uuid: opts.server_uuid,
        fields: 'uuid,owner_uuid,quota,max_physical_memory,zone_state,state,' +
            'brand,cpu_cap,last_modified'
    };

    if (opts.predicate) {
        args.predicate = JSON.stringify(opts.predicate);
    }

    vmapi.listVms(args, callback);
};


/**
 * Fetch and return a VM from VMAPI.
 */

ModelVM.getVmViaVmapi =
function (opts, callback) {
    var self = this;

    assert.string(opts.uuid, 'opts.uuid');

    var vmapi = new sdcClients.VMAPI({
        url: self.app.config.vmapi.url,
        connectTimeout: 5000
    });
    vmapi.getVm({
        uuid: opts.uuid
    }, function (err, vm) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, vm);
        return;
    });
};


module.exports = ModelVM;
