/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
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
 * - Workflow sends provisioner task to server to update nic tags
 * - Set server setup => true
 */

var VERSION = '1.0.2';

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

function fetchSetupFiles(job, callback) {
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var assetsUrl = job.params.assets_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var overprovision_ratio = job.params.overprovision_ratio || '1.0';

    var script = [
        '#!/bin/bash',
        'set -o xtrace',
        'cd /var/tmp',
        'mkdir /var/tmp/node.config',
        '(echo "overprovision_ratio=\'' + overprovision_ratio + '\'"; '
            + 'curl $1/extra/joysetup/node.config) > node.config/node.config',
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
            job.log.info('Error executing joysetup: ' + error.message);
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

function pingProvisioner(job, callback) {
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var amqpHost = job.params.amqp_host;
    var cnapi = restify.createJsonClient({ url: cnapiUrl });

    var script = [
        '#!/bin/bash',
        '[[ -z $(sysinfo | json "SDC Version") ]] && AMQP_HOST=$(sysinfo | '
            + 'json "Boot Parameters".rabbitmq | cut -d":" -f3)',
        'echo AMQP_HOST = $AMQP_HOST',
        '/opt/smartdc/agents/bin/ping-agent '
            + job.params.server_uuid + ' provisioner'
    ].join('\n');

    var payload = {
        script: script,
        env: { AMQP_HOST: amqpHost }
    };

    cnapi.post(urUrl, payload, function (error, req, res) {
        if (error) {
            job.log.info('Error executing ping provisioner task via CNAPI: '
                + error.message);
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }

        job.log.info({ body: res.body }, 'body received');
        if (!res.body.indexOf('req_id') === -1) {
            callback(new Error('provisioner ping was unsuccessful'));
            return;
        }
        callback();
    });
}

function touchSetupComplete(job, callback) {
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    var script = [
        '#!/bin/bash',
        'touch /var/svc/setup_complete'
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

// XXX most of this comes from sendRebootMessage in the server-reboot job
//     should refactor.
function rebootServer(job, callback) {
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';

    var payload = {
        script: '#!/bin/bash\nexit 113'
    };

    job.log.info('rebootServer');

    if (!job.params.hostname) {
        job.log.info('No need to reboot, hostname not set');
        callback();
        return;
    }

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
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var timer;
    var serverUrl = '/servers/' + job.params.server_uuid;

    job.log.info('waitForReboot()');

    if (!job.params.hostname) {
        job.log.info('No need to wait for reboot, hostname not set');
        callback();
        return;
    }

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
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';

    var payload = {
        script:
            '#!/bin/bash\n'+
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
            name: 'cnapi.ping_provisioner',
            timeout: 30,
            retry: 3,
            body: pingProvisioner
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
            name: 'cnapi.refresh_server_sysinfo',
            timeout: 1000,
            retry: 1,
            body: cnapiCommon.refreshServerSysinfo
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
