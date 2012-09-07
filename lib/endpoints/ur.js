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
var ModelServer = require('../models/server');

function Ur() {}

Ur.update = function (req, res, next) {
    var params = {
        env: req.params.env,
        args: req.params.args
    };

    var script = req.params.script;

    req.params.server.invokeUrScript(script, params, onInvoke);

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

            req.params.server = new ModelServer(req.params.server_uuid);
            req.params.server.get(function (error, server) {
                // Check if any servers were returned
                if (!server) {
                    var errorMsg
                        = 'Server ' + req.params.server_uuid + ' not found';
                    next(
                        new restify.ResourceNotFoundError(errorMsg));
                    return;
                }
                req.params.serverAttributes = server;
                next();
            });
        }
    ];
    // Invoke script through ur
    http.post(
        { path: '/servers/:server_uuid/execute', name: 'UpdateUr' },
        before, Ur.update);
}

exports.attachTo = attachTo;
