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

var mod_restify = require('restify');

function Ur() {}

Ur.update = function (req, res, next) {
    var model = this.model;

    var uuid = req.params.server_uuid;
    var script = req.params.script;

    model.serverInvokeUrScript(uuid, script, function (err, stdout, stderr) {
        if (err)
            return (next(new mod_restify.InternalError(err.message)));

        res.send(stdout.trim());
        return (next());
    });
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // Invoke script through ur
    http.post(
        { path: '/ur/:server_uuid', name: 'UpdateUr' },
        Ur.update.bind(toModel));
}

exports.attachTo = attachTo;
