/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/*
 * This is the workflow responsible for setting up a compute node.
 *
 * - CNAPI receives setup HTTP request
 * - CNAPI starts workflow
 * - Workflow gets current server nics from NAPI
 * - Workflow adds to those nics any nic tags specified in setup params
 * - Workflow updates nics in NAPI with changes
 * - Workflow has compute node fetch node.config
 * - Workflow has compute node fetch joysetup.sh
 * - Workflow has compute node fetch agentsetup.sh
 * - Workflow creates an Ur script which fetches and runs joysetupper
 * - Workflow sends cn-agent task to server to update nic tags
 * - Set server setup => true
 */

var VERSION = '1.0.6';

var cnapiCommon = require('wf-shared').cnapi;
var napiCommon = require('wf-shared').napi;
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

    if (!job.params.assets_url) {
        callback(new Error('Must specify assets_url'));
        return;
    }

    if (!job.params.amqp_host) {
        callback(new Error('Must specify amqp_host'));
        return;
    }

    callback(null, 'All parameters OK!');
}

function markServerAsSettingUp(job, callback) {
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var serverUrl = '/servers/' + job.params.server_uuid;

    var payload = {
        etag_retries: 3,
        setting_up: true
    };

    cnapi.post(serverUrl, payload, function (error, req, res) {
        if (error) {
            job.log.info('Error setting server as setting_up');
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}

/*
 * Later tasks in this job use CNAPI CommandExecute to run setup commands on
 * the server. CommandExecute will attempt to use cn-agent if `<server>.agents`
 * suggests there is a sufficient cn-agent on the server. However, if the
 * server has been `sdc-factoryreset`, then it won't have any agents, but
 * CNAPI's server record won't know that.
 *
 * The `<server>.agents` will get populated later in the setup when new
 * agents are installed.
 */
function clearServerAgents(job, callback) {
    var serverUrl = '/servers/' + job.params.server_uuid;
    var cnapi = restify.createJsonClient({ url: job.params.cnapi_url});

    var update = {
        agents: []
    };
    cnapi.post(serverUrl, update, function (err, req, res) {
        if (err) {
            job.log.info('Error clearing server.agents: ' + err.message);
            job.log.info(err.stack.toString());
            callback(err);
            return;
        }
        callback();
    });
}

function fetchSetupFiles(job, callback) {
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var assetsUrl = job.params.assets_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var nodeConfigDir = 'config-' + job.params.server_uuid;
    var diskCfg = '';
    if (job.params.disk_layout) {
        diskCfg += 'echo "layout=\'' + job.params.disk_layout + '\'"; ';
    }
    if (job.params.hasOwnProperty('disk_cache')) {
        diskCfg += 'echo "cache=\'' + job.params.disk_cache + '\'"; ';
    }
    if (job.params.hasOwnProperty('disk_spares')) {
        diskCfg += 'echo "spares=' + job.params.disk_spares + '"; ';
    }
    if (job.params.hasOwnProperty('disk_width')) {
        diskCfg += 'echo "width=' + job.params.disk_width + '"; ';
    }

    if (job.params.hasOwnProperty('disk_exclude')) {
        diskCfg += 'echo "disk_exclude=\'' +
            job.params.disk_exclude + '\'"; ';
    }

    if (job.params.hasOwnProperty('encryption_enabled')) {
        diskCfg += 'echo "encryption_enabled=\'' +
            job.params.encryption_enabled + '\'"; ';
    }

    var script = [
        '#!/bin/bash',
        'set -o xtrace',
        'cd /var/tmp',
        'mkdir /var/tmp/node.config',
        'mkdir /var/tmp/' + nodeConfigDir,
        '(' + diskCfg +
             'curl $1/extra/joysetup/node.config) | tee ' + nodeConfigDir +
             '/node.config node.config/node.config >&-',
        'curl -O $1/extra/joysetup/joysetup.sh',
        'curl -O $1/extra/joysetup/agentsetup.sh',
        'chmod +x *.sh'
    ].join('\n');

    var payload = {
        script: script,
        args: [assetsUrl]
    };

    cnapi.post(urUrl, payload, function (error, req, res) {
        if (error) {
            job.log.info('Error fetching setup files: ' + error.message);
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}

function executeJoysetupScript(job, callback) {
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    var script = [
        '#!/bin/bash',
        'set -o xtrace',
        'cd /var/tmp',
        './joysetup.sh'
    ].join('\n');

    var payload = {
        script: script
    };

    cnapi.post(urUrl, payload, function (error, req, res) {
        if (error) {
            job.log.info('Error executing joysetup: ' + error.message);
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        job.log.info('Successfully executed joysetup script');
        callback();
    });
}

function executeAgentSetupScript(job, callback) {
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var assetsUrl = job.params.assets_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    var script = [
        '#!/bin/bash',
        'set -o xtrace',
        'cd /var/tmp',
        'echo ASSETS_URL = $ASSETS_URL',
        './agentsetup.sh'
    ].join('\n');

    var payload = {
        script: script,
        env: { ASSETS_URL: assetsUrl }
    };

    cnapi.post(urUrl, payload, function (error, req, res) {
        if (error) {
            job.log.info('Error executing agent setup via CNAPI:'
                + error.message);
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}

function touchSetupComplete(job, callback) {
    if (job.params.server && job.params.server.sysinfo &&
        job.params.server.sysinfo['System Type'] === 'linux') {
        // Don't bother adding this file on linux - not needed.
        callback(null, 'OK - not needed on Linux');
        return;
    }

    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    var setupCompleteFilePath = '/var/svc/setup_complete';

    var script = [
        '#!/bin/bash',
        'touch ' + setupCompleteFilePath
    ].join('\n');

    var payload = {
        script: script
    };

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

function runPostSetupScript(job, callback) {
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    if (!job.params.postsetup_script) {
        callback();
        return;
    }

    var payload = {
        script: job.params.postsetup_script
    };

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

function markServerAsSetup(job, callback) {
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var serverUrl = '/servers/' + job.params.server_uuid;

    var payload = {
        etag_retries: 3,
        setup: true,
        setting_up: false
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

/*
 * Note that we always reboot the CN even if the hostname param isn't set.  This
 * is because an un-setup server is in a slightly odd state - without the zones
 * pool, vmadmd will be disabled.  Worse, joysetup.sh needs to replace /var, and
 * the way it does that effectively stomps on /var/run, and in particular any
 * door servers there.  The simplest way to get to a sane state is to reboot.
 *
 * XXX most of this comes from sendRebootMessage in the server-reboot job;
 * should refactor.
 */
function rebootServer(job, callback) {
    if (job.params.server && job.params.server.sysinfo &&
            job.params.server.sysinfo['System Type'] === 'linux') {
        callback(null, 'OK - reboot on Linux is not required');
        return;
    }

    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';

    var payload = {
        script: '#!/bin/bash\nexit 113'
    };

    job.log.info('rebootServer');

    cnapi.post(urUrl, payload, function (error, req, res) {
        job.log.info('rebootServer (post)');
        if (error) {
            job.log.info('Error posting to Ur via CNAPI:' + error.message);
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}

function waitForReboot(job, callback) {
    if (job.params.server && job.params.server.sysinfo &&
            job.params.server.sysinfo['System Type'] === 'linux') {
        callback(null, 'OK - waitForReboot on Linux is not required');
        return;
    }

    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var timer;
    var serverUrl = '/servers/' + job.params.server_uuid;

    job.log.info('waitForReboot()');

    function checkRebooted() {
        cnapi.get(serverUrl, function (err, req, res, server) {
            var cn_state;
            var created_at;
            var last_boot;

            if (err) {
                job.log.info(
                    'Error getting server info from CNAPI:' + err.message);
                job.log.info(err.stack.toString());
                clearTimeout(timer);
                callback(err);
                return;
            }

            job.log.info('waitForReboot() got result from CNAPI');

            cn_state = server.status;
            job.log.info('cn_state: ' + cn_state);
            created_at = (new Date(job.created_at).getTime() / 1000);
            job.log.info('created_at: ' + created_at);
            last_boot = (new Date(server.last_boot).getTime() / 1000);
            job.log.info('last_boot: ' + last_boot);

            if (cn_state === 'running' && (last_boot > created_at)) {
                clearTimeout(timer);
                callback();
                return;
            }
            timer = setTimeout(checkRebooted, 5000);
        });
    }

    timer = setTimeout(checkRebooted, 5000);
}


/*
 * Restart Ur post-setup so that it can log to the new correct location (the
 * zones zpool)
 */
function restartUr(job, callback) {
    if (job.params.server && job.params.server.sysinfo &&
            job.params.server.sysinfo['System Type'] === 'linux') {
        callback(null, 'OK - reboot of Ur on Linux is not required');
        return;
    }

    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';

    var payload = {
        script:
            '#!/bin/bash\n' +
            'nohup /bin/bash -c ' +
                '"(/usr/bin/sleep 5; /usr/sbin/svcadm restart ur) &"'
    };

    job.log.info('restartUr');

    cnapi.post(urUrl, payload, function (error, req, res) {
        job.log.info('restartUr (post)');
        if (error) {
            job.log.info('Error posting to Ur via CNAPI:' + error.message);
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}

module.exports = {
    name: 'server-setup-' + VERSION,
    version: VERSION,
    timeout: 2 * 60 * 60,
    onerror: [
        {
            name: 'onerror',
            body: function (_job, cb) {
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
        {
            // Update nics early in the chain, in case there are
            // NAPI validation failures
            name: 'napi.update_nics',
            timeout: 120,
            retry: 1,
            body: napiCommon.updateNics
        },
        {
            name: 'cnapi.mark_as_setting_up',
            timeout: 10,
            retry: 1,
            body: markServerAsSettingUp
        },
        {
            name: 'cnapi.clear_server_agents',
            timeout: 10,
            retry: 1,
            body: clearServerAgents
        },
        {
            name: 'cnapi.fetch_setup_files',
            timeout: 10,
            retry: 1,
            body: fetchSetupFiles
        },
        {
            name: 'cnapi.execute_joysetup_script',
            timeout: 3600,
            retry: 1,
            body: executeJoysetupScript
        },
        {
            name: 'cnapi.execute_agentsetup_script',
            timeout: 3600,
            retry: 1,
            body: executeAgentSetupScript
        },
        {
            name: 'cnapi.update_nics',
            timeout: 3600,
            retry: 1,
            body: cnapiCommon.nicUpdate
        },
        {
            name: 'cnapi.poll_tasks',
            timeout: 3600,
            retry: 1,
            body: cnapiCommon.pollTasks
        },
        {
            name: 'cnapi.touch_setup_complete',
            timeout: 1000,
            retry: 1,
            body: touchSetupComplete
        },
        {
            name: 'cnapi.reboot_server',
            timeout: 600,
            retry: 1,
            body: rebootServer
        },
        {
            name: 'cnapi.wait_for_reboot',
            timeout: 1200,
            retry: 1,
            body: waitForReboot
        },
        {
            name: 'cnapi.run_postsetup_script',
            timeout: 1000,
            retry: 1,
            body: runPostSetupScript
        },
        {
            name: 'cnapi.restart_ur',
            timeout: 1000,
            retry: 1,
            body: restartUr
        },
        {
            name: 'cnapi.mark_server_as_setup',
            timeout: 1000,
            retry: 1,
            body: markServerAsSetup
        }
    ]
};
