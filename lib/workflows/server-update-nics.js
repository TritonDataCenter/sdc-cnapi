/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This is the workflow responsible for updating nics on a compute node.
 *
 * - CNAPI receives nic update HTTP request
 * - CNAPI starts workflow
 * - Workflow gets current server nics from NAPI
 * - Workflow applies any changes to those nics
 * - Workflow posts back to CNAPI to start update nics cn-agent task
 * - Workflow polls CNAPI for result of the cn-agent task
 * - Workflow refreshes sysinfo to get the updated tags
 */

var VERSION = '1.0.1';

var cnapiCommon = require('wf-shared').cnapi;
var napiCommon = require('wf-shared').napi;
var restify = require('restify');

function validateParams(job, callback) {
    if (!job.params.server_uuid) {
        callback(new Error('Must specify server_uuid'));
        return;
    }

    callback(null, 'All parameters OK!');
}

module.exports = {
    name: 'server-update-nics-' + VERSION,
    version: VERSION,
    timeout: 2*60*60,
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
        },
        {
            name: 'napi.validate_nic_params',
            timeout: 10,
            retry: 1,
            body: napiCommon.validateNicParams
        },
        {
            name: 'napi.get_current_nics',
            timeout: 120,
            retry: 1,
            body: napiCommon.getServerNics
        },
        {
            name: 'napi.apply_nic_updates',
            timeout: 10,
            retry: 1,
            body: napiCommon.applyNicUpdates
        },

        // XXX: error out if deleting and there are VMs on that nic tag
        {
            name: 'napi.update_nics',
            timeout: 120,
            retry: 1,
            body: napiCommon.updateNics
        },
        {
            name: 'cnapi.update_nics',
            timeout: 120,
            retry: 1,
            body: cnapiCommon.nicUpdate
        },
        {
            name: 'cnapi.poll_tasks',
            timeout: 120,
            retry: 1,
            body: cnapiCommon.pollTasks
        },
        {
            name: 'cnapi.refresh_server_sysinfo',
            timeout: 1000,
            retry: 1,
            body: cnapiCommon.refreshServerSysinfo
        }
    ]
};
