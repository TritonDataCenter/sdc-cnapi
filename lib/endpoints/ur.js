/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
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
 * @section Remote Execution
 *
 * @param {Array} args Array containing arguments to be passed in to command
 * @param {Object} env Object containing environment variables to be passed in
 * @param {String} script Script to be executed. Must have a shebang line
 *
 * @response 404 None No such server
 * @resposne 500 None Error occurred executing script
 */

Ur.execute = function (req, res, next) {
    var rules = {
        'args': ['optional', 'isArray'],
        'env': ['optional', 'isObjectType'],
        'script': ['isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var params = {
        env: req.params.env,
        args: req.params.args
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

function attachTo(http, model) {
    var before = [
        function (req, res, next) {
            if (!req.params.server_uuid) {
                next();
                return;
            }

            req.connection.setTimeout(60 * 60 * 1000);

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
    // Invoke script through ur
    http.post(
        { path: '/servers/:server_uuid/execute', name: 'CommandExecute' },
        before, Ur.execute);
}

exports.attachTo = attachTo;
