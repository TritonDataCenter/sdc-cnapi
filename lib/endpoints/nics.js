/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * HTTP endpoints to manage server nics
 */

var common = require('../common');
var restify = require('restify');
var util = require('util');
var validation = require('../validation/endpoints');
var ModelServer = require('../models/server');


function Nic() {}

/**
 * Modify the target server's nics.
 *
 * The only parameter of the server's nics that can be changed is
 * nic_tags_provided. This parameter can be changed depending on the following
 * values for the *action* parameter:
 *
 * * update: Add nic tags to the target nics
 * * replace: Replace the nic tags (ie: completely overwrite the list) for the
 *   target nics
 * * delete: Remove the nic tags from the target nics
 *
 * For examples, see the [Updating Nics](#updating-nics) section above.
 *
 * As per the [Updating Nics](#updating-nics) section above, the **nics**
 * parameter must be an array of objects. Those objects must have both the
 * **mac** and **nic_tags_provided** properties.
 *
 * @name NicUpdate
 * @endpoint PUT /servers/:server_uuid/nics
 * @section Miscellaneous API
 *
 * @param {String} action Nic action: 'update', 'replace' or 'delete'.
 * @param {Object} nics Array of nic objects.
 *
 * @response 202 None Workflow was created to modify nics
 * @response 404 Error No such server
 * @resposne 500 Error Error occured with request: invalid parameters, server
 *     not setup, or error instantiating workflow
 */
Nic.update = function handlerNicUpdate(req, res, next) {
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
            msg: 'action must be \'update\', \'replace\', or \'delete\''
        }]));
        next();
        return;
    }

    if (server.value.setup !== true) {
        next(new restify.InternalError('Server is not setup'));
        return;
    }

    var wfParams = {
        nic_action: action,
        nics: req.params.nics,
        server_uuid: uuid,
        target: uuid,
        origin: req.params.origin,
        creator_uuid: req.params.creator_uuid
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

Nic.updateTask = function handlerNicUpdateTask(req, res, next) {
    var self = this;
    var server = req.stash.server;

    req.log.info({server: server.uuid, params: req.params},
        'sending nic_update task');
    server.sendTaskRequest({
        task: 'server_update_nics',
        params: req.params,
        req: req,
        evcb: ModelServer.createComputeNodeAgentHandler(self, req.params.jobid),
        cb: function (error, task) {
            res.send({ id: task.id });
            return next();
        }});
};

function attachTo(http, app) {
    var ensure = require('../endpoints').ensure;

    // Update nics on the server
    http.put(
        { path: '/servers/:server_uuid/nics', name: 'NicUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Nic.update);

    // Start cn-agent task for updating nics (internal: should be used by the
    // server-update-nics workflow only)
    http.post(
        { path: '/servers/:server_uuid/nics/update', name: 'UpdateNicTask' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Nic.updateTask);
}

exports.attachTo = attachTo;
