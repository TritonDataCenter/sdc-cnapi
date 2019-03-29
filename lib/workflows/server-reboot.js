/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * This is the workflow responsible for rebooting up a compute node.
 *
 */

var VERSION = '1.1.0';

var cnapiCommon = require('wf-shared').cnapi;
var napiCommon = require('wf-shared').napi;
var sdcClients = require('sdc-clients');
var restify = require('restify');

function validateParams(job, callback) {
    if (!job.params.server_uuid) {
        callback(new Error('Must specify server_uuid'));
        return;
    }

    if (!job.params.cnapi_url) {
        callback(new Error('Must specify cnapi_url'));
        return;
    }

    callback(null, 'All parameters OK!');
}

function pauseCnTaskHandler(job, callback) {
    // Only with "job.params.drain"
    if (!job.params.drain) {
        callback(null, 'No need to pause cn-agent');
        return;
    }
    var pause = '/servers/' + job.params.server_uuid + '/cn-agent/pause';
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    cnapi.post(pause, {}, function (error, req, res) {
        if (error) {
            job.log.info('Error trying to pause cn-agent via CNAPI:' +
                    error.message);
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}


function waitForCnAgentDrained(job, callback) {
    // Only with "job.params.drain"
    if (!job.params.drain) {
        callback();
        return;
    }

    var attempts = 0;
    var errors = 0;

    var timeout = 5000;  // 5 seconds
    var limit = 180;     // 15 minutes

    var hPath = '/servers/' + job.params.server_uuid + '/task-history';
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    function _waitForRunningTasks() {
        cnapi.get(hPath, function (err, req, res, history) {
            attempts += 1;

            if (err) {
                errors += 1;
                if (errors >= 5) {
                    callback(err);
                    return;
                } else {
                    setTimeout(_waitForRunningTasks, timeout);
                    return;
                }
            }

            var runningTasks = [];

            if (history && history.length) {
                runningTasks = history.filter(function (t) {
                    return (t.status === 'active');
                });
            }

            if (runningTasks.length) {
                if (attempts > limit) {
                    callback(new Error(
                        'Waiting for cn-agent tasks to drain timed out'));
                    return;
                } else {
                    setTimeout(_waitForRunningTasks, timeout);
                    return;
                }
            } else {
                callback();
                return;
            }
        });
    }
    _waitForRunningTasks();
}


//
// This function has 2 modes depending on whether the supportsServerRebootTask
// parameter is true or not. If true, this will call ServerReboot with the
// nojob=true parameter which will result in a server_reboot task being run on
// the CN via cn-agent. Otherwise, this will send a script to CommandExecute
// which will 'exit 113' and reboot the server. Ideally this second mode will
// eventually go away, since we'd like to do away with Ur (HEAD-1946) and this
// special exit code (AGENT-733).
//
function sendRebootMessage(job, callback) {
    var cnapiUrl = job.params.cnapi_url;
    var rebootUrl = '/servers/' + job.params.server_uuid + '/reboot';
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';

    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    var payload = {
        script: '#!/bin/bash\nexit 113'
    };

    job.log.debug({params: job.params}, 'sendRebootMessage job params');

    if (job.params.supportsServerRebootTask) {
        cnapi.post(rebootUrl, {nojob: true}, function (err, req, res) {
            job.log.info({
                err: err,
                req: req,
                res: res
            }, 'POSTed reboot with nojob=true');
            callback(err);
        });
        return;
    }

    cnapi.post(urUrl, payload, function (error, req, res) {
        if (error) {
            job.log.info('Error posting to Ur via CNAPI:' + error.message);
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}

function markServerAsRebooting(job, callback) {
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var serverUrl = '/servers/' + job.params.server_uuid;

    var payload = {
        etagRetries: 3,
        transitional_status: 'rebooting'
    };

    cnapi.post(serverUrl, payload, function (error, req, res) {
        if (error) {
            job.log.info('Error setting server as setup');
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}

module.exports = {
    name: 'server-reboot-' + VERSION,
    version: VERSION,
    timeout: 2 * 60 * 60,
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
            name: 'cnapi.pause_cn_agent_task_handler',
            timeout: 30,
            retry: 1,
            body: pauseCnTaskHandler
        },
        {
            name: 'cnapi.wait_for_cn_agent_drained',
            timeout: 15 * 60,
            retry: 1,
            body: waitForCnAgentDrained
        },
        {
            name: 'cnapi.send_reboot_message',
            timeout: 10,
            retry: 1,
            body: sendRebootMessage
        },
        {
            name: 'cnapi.mark_server_as_rebooting',
            timeout: 10,
            retry: 1,
            body: markServerAsRebooting
        }
    ]
};
