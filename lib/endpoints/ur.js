/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * ur.js: Ur endpoints
 *
 * The single /ur/:server_uuid endpoint invokes scripts through the ur agent.
 * This can be tested with:
 *
 *   $ sdc-cnapi /ur/$UUID -X POST -d 'script=echo Hello world'
 */

var restify = require('restify');

var validation = require('../validation/endpoints');
var ModelServer = require('../models/server');

function Ur() {}

/**
 * Synchronously execute a command on the target server.
 *
 * @name CommandExecute
 * @endpoint POST /servers/:server_uuid/execute
 * @section Remote Execution API
 *
 * @param {Array} args Array containing arguments to be passed in to command
 * @param {Object} env Object containing environment variables to be passed in
 * @param {String} script Script to be executed. Must have a shebang line
 * @param {Number} script Maximum time to wait for a reply from the server,
 * expressed in seconds
 *
 * @response 404 None No such server
 * @response 500 None Error occurred executing script
 */
Ur.execute = function (req, res, next) {
    var rules = {
        'args': ['optional', 'isArray'],
        'env': ['optional', 'isObjectType'],
        'script': ['isStringType'],
        'timeout': ['optional', 'isNumberType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var timeout;
    if (req.params.timeout) {
        switch (typeof (req.params.timeout)) {
        case 'number':
            timeout = req.params.timeout;
            break;
        case 'string':
            timeout = parseInt(req.params.timeout);
            break;
        }

        /*
         * The client provides a timeout in seconds, but the urclient module
         * expects milliseconds.
         */
        timeout *= 1000;
    }

    var params = {
        env: req.params.env,
        args: req.params.args,
        timeout: timeout
    };

    var script = req.params.script;

    req.stash.server.invokeUrScript(script, params, onInvoke);

    function onInvoke(err, stdout, stderr) {
        if (err)
            return (next(new restify.InternalError(err.message)));

        res.send(stdout.trim());
        return (next());
    }
};

function attachTo(http, app) {
    var ensure = require('../endpoints').ensure;

    // Invoke script through ur
    http.post(
        { path: '/servers/:server_uuid/execute', name: 'CommandExecute' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray']
        }),
        Ur.execute);
}

exports.attachTo = attachTo;
