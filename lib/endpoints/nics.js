/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints to manage server nics
 */

var common = require('../common');
var restify = require('restify');
var util = require('util');
var validation = require('../validation/endpoints');
var ModelServer = require('../models/server');


function Nic() {}

Nic.update = function (req, res, next) {
    var rules = {
        'action': ['isStringType'],
        'nics': ['isArrayType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var action = req.params.action;
    var self = this;
    var server = req.stash.server;
    var uuid = server.uuid;

    if (action !== 'update' && action !== 'replace' && action !== 'delete') {
        res.send(500, validation.formatValidationErrors([ {
            param: 'action',
            message: 'action must be \'update\', \'replace\', or \'delete\''
        }]));
        next();
        return;
    }

    var wfParams = {
        nic_action: action,
        nics: req.params.nics,
        server: server,
        server_uuid: uuid,
        target: uuid
    };

    self.log.info('Instantiating server-update-nics workflow');
    ModelServer.getWorkflow().getClient().createJob(
        'server-update-nics',
        wfParams,
        function (error, job) {
            if (error) {
                self.log.error('Error in workflow: %s', error.message);
                next(new restify.InternalError(error.message));
                return;
            }

            self.log.info('server-update-nics workflow started with job '
                + 'UUID ' + job.uuid);
            res.send(202, { job_uuid: job.uuid });
            return;
        });
};

Nic.updateTask = function (req, res, next) {
    var self = this;
    var server = req.stash.server;

    req.log.info({server: server.uuid, params: req.params},
        'sending nic_update task');
    server.sendProvisionerTask(
        'server_update_nics',
        req.params,
        ModelServer.createProvisionerEventHandler(self, req.params.jobid),
        function (error, task_id) {
            res.send({ id: task_id });
            return next();
        });
};

function attachTo(http) {
    var before = [
        function (req, res, next) {
            if (!req.params.server_uuid) {
                next();
                return;
            }

            req.stash = {};
            req.stash.server = new ModelServer(req.params.server_uuid);
            req.stash.server.getRaw(function (error, server) {
                // Check if any servers were returned
                if (!server) {
                    var errorMsg
                        = 'Server ' + req.params.server_uuid + ' not found';
                    next(
                        new restify.ResourceNotFoundError(errorMsg));
                    return;
                }
                next();
            });
        }
    ];

    // Update nics on the server
    http.put(
        { path: '/servers/:server_uuid/nics', name: 'NicUpdate' },
        before, Nic.update);

    // Start provisioner task for updating nics
    http.post(
        { path: '/servers/:server_uuid/nics/update', name: 'UpdateNicTask' },
        before, Nic.updateTask);
}

exports.attachTo = attachTo;
