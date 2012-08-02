/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This is the workflow responsible for setting up a compute node.
 *
 * - CNAPI receives setup HTTP request
 * - CNAPI starts workflow
 * - Workflow has compute node fetch node.config
 * - Workflow has compute node fetch joysetup.sh
 * - Workflow has compute node fetch agentsetup.sh
 * - Workflow creates an Ur script which fetches and runs joysetupper
 * - Set server setup => true
 */

var VERSION = '1.0.0';

var sdcClients = require('sdc-clients');
var uuid = require('node-uuid');
var restify = require('restify');

function validateParams(job, callback) {
    if (!job.params.server_uuid) {
        callback(new Error('Must specify server_uuid'));
        return;
    }

    if (!job.params.sysinfo) {
        callback(new Error('Must specify sysinfo'));
        return;
    }
    callback();
}

module.exports = {
    name: 'server-sysinfo-' + VERSION,
    version: VERSION,
    onerror: [
        {
            name: 'onerror',
            body: function (job, cb) {
                cb(new Error('Error executing job'));
            }
        }
    ],

    chain: [
        {
            name: 'cnapi.validate_params',
            timeout: 10,
            retry: 1,
            body: validateParams
        }
    ]
};
