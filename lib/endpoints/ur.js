/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * ur.js: Ur endpoints
 *
 * The /servers/:server_uuid/execute endpoint invokes scripts on servers. If the
 * server has old agents that don't support the command_execute task, the
 * lib/endpoints/servers.js Server.execute function will call the execute
 * function here to handle the request through the ur agent.
 *
 * This can be tested with:
 *
 * $ sdc-cnapi /servers/UUID/execute -X POST -d '{"script": "echo Hello world"}'
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
 *
 * @response 404 None No such server
 * @resposne 500 None Error occurred executing script
 */

Ur.execute = function handlerUrExecute(req, res, next) {
    var rules = {
        'args': ['optional', 'isArrayType'],
        'env': ['optional', 'isObjectType'],
        'script': ['isStringType'],
        'timeout': ['optional', 'isNumberType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var params = {
        env: req.params.env,
        args: req.params.args,
        timeout: req.params.timeout
    };

    var script = req.params.script;

    req.stash.server.invokeUrScript(script, params, onInvoke);

    function onInvoke(err, stdout, stderr, exitStatus) {
        if (err)
            return (next(new restify.InternalError(err.message)));

        if (req.params.json) {
            res.send({
                exitCode: exitStatus,
                stderr: stderr,
                stdout: stdout
            });
        } else {
            // for backward compat we want to return a useless error if
            // script exited non-zero.
            if (exitStatus !== 0) {
                return (next(new restify.InternalError(
                    'Error executing on remote system')));
            }
            // backward compatibly lose stderr and exit code
            res.send(stdout.trim());
        }

        return (next());
    }
};

module.exports = Ur;
