/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This is the workflow responsible for resetting a compute node its factory
 * settings.
 *
 */

var sdcClients = require('sdc-clients');
var restify = require('restify');

var VERSION = '1.0.0';


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

function executeFactoryResetScript(job, callback) {
    var urUrl = '/servers/' + job.params.server_uuid + '/execute';
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});

    var script = [
        '#!/bin/bash',
        'set -o xtrace',
        'SYS_ZPOOL=$(/usr/bin/svcprop -p config/zpool smartdc/init)',
        '[[ -n ${SYS_ZPOOL} ]] || SYS_ZPOOL=zones',
        '/usr/sbin/zfs set smartdc:factoryreset=yes ${SYS_ZPOOL}/var',
        'exit 113'
    ].join('\n');

    var payload = {
        script: script,
        args: []
    };

    cnapi.post(urUrl, payload, function (error, req, res) {
        if (error) {
            console.error('Error posting to Ur via CNAPI');
            callback(error);
            return;
        }
        callback();
    });
}

function pollSetupComplete(job, callback) {
    var cnapiUrl = job.params.cnapi_url;
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var period = 30 * 1000;
    var waited = 0;
    var totalWait = 600 * 1000;

    var interval = setInterval(function () {
        waited += period;
        if (waited >= totalWait) {
            clearInterval(interval);
            callback('workflow task timed out after '
                + (totalWait / 1000) + ' seconds');
            return;
        }
        cnapi.get('/servers/' + job.params.server_uuid, onget);
    }, period);

    function onget(error, req, res, server) {
        if (error) {
             callback(error);
             return;
        }

        if (server.setup === true) {
            clearInterval(interval);
            callback();
        }
    }
}

module.exports = {
    name: 'server-factory-reset-' + VERSION,
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
        },
        {
            name: 'cnapi.execute_factory_reset_script',
            timeout: 10,
            retry: 1,
            body: executeFactoryResetScript
        }
    ]
};
