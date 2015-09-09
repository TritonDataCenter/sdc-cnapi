/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var fs = require('fs');
var util = require('util');
var path = require('path');
var verror = require('verror');
var restify = require('restify');
var assert = require('assert-plus');


var allocator = require('./allocator');
var boot_params = require('./boot_params');
var fw = require('./fw');
var ModelImage = require('../models/image');
var ModelServer = require('../models/server');
var images = require('./images');
var nics = require('./nics');
var platforms = require('./platforms');
var servers = require('./servers');
var waitlist = require('./waitlist');
var tasks = require('./tasks');
var ur = require('./ur');
var vms = require('./vms');
var zfs = require('./zfs');


var CONNECTION_CHECKS = {
    transport: ensureConnectedToTransport,
    moray: ensureConnectedToMoray,
    amqp: ensureConnectedToAMQP,
    workflow: ensureConnectedToWorkflow
};

var PREPOPULATE_FNS = {
    server: prepopulateServer,
    vm: prepopulateVm,
    image: prepopulateImage
};

function ensureConnectedToMoray(opts, req, res, next) {
    if (!opts.app.moray.connected) {
        next(new restify.InternalError(
            'Precondition failed: no connection moray'));
        return;
    }
    next();
}

function ensureConnectedToAMQP(opts, req, res, next) {
    if (!opts.app.amqpConnection.connected) {
        next(new restify.InternalError(
            'Precondition failed: no connection to AMQP'));
        return;
    }
    next();
}

function ensureConnectedToTransport(opts, req, res, next) {
    // if transport is AMQP this will ensure it's connected
    var transport = req.stash.server.getValue().transport;
    if (transport === 'amqp') {
        ensureConnectedToAMQP(opts, req, res, next);
        return;
    }
    next();
}

function ensureConnectedToWorkflow(opts, req, res, next) {
    if (!opts.app.workflow.connected) {
        next(new restify.InternalError(
            'Precondition failed: no connection to Workflow API'));
        return;
    }
    next();
}

function ensureConnectionTimeout(opts, req, res, next) {
    req.connection.setTimeout(opts.connectionTimeoutSeconds * 1000);
    next();
}

function prepopulateServer(opts, req, res, next) {
    assert.string(req.params.server_uuid, 'server_uuid');

    ModelServer.get(
        req.params.server_uuid,
        function (err, servermodel, server) {
            if (err) {
                req.log.error(err);
                next(new restify.InternalError(err.message));
                return;
            }

            // Check if any servers were returned
            if (!server) {
                var errorMsg = 'Server ' + req.params.server_uuid
                    + ' not found';
                next(new restify.ResourceNotFoundError(errorMsg));
                return;
            }
            req.stash.server = servermodel;
            next();
        });
}

function prepopulateVm(opts, req, res, next) {
    assert.string(req.params.uuid, 'uuid');

    var uuid = req.params.uuid;

    req.stash.server.getRaw(function (error, server) {
        if (error) {
            req.log.error(error);
            next(new restify.InternalError(error.message));
            return;
        }

        // Check if any servers were returned
        if (!server) {
            var errorMsg = 'Server ' + req.params.server_uuid + ' not found';
            next(new restify.ResourceNotFoundError(errorMsg));
            return;
        }

        if (!server.vms || !server.vms[uuid]) {
            errorMsg = 'VM ' + uuid + ' not found';
            next(new restify.ResourceNotFoundError(errorMsg));
            return;
        }

        req.stash.vm = req.stash.server.getVM(uuid);
        next();
    });
}


function prepopulateImage(opts, req, res, next) {
    assert.string(req.params.server_uuid, 'server_uuid');
    req.stash.image = new ModelImage({
        serverUuid: req.params.server_uuid,
        uuid: req.params.uuid
    });
    next();
}

function ensure(opts) {
    var fns = [];

    opts.log = opts.app.getLog();
    opts.connectionTimeoutSeconds = opts.connectionTimeoutSeconds || 60 * 60;

    // Override timeout
    fns.push(function (req, res, next) {
        if (!req.stash) {
            req.stash = {};
            req.stash.app = opts.app;
        }
        next();
    });

    fns.push(function (req, res, next) {
        ensureConnectionTimeout(opts, req, res, next);
    });

    var connected = opts.connected || [];
    var prepopulate = opts.prepopulate || [];

    // If we're checking moray, do it first.
    var idx = connected.indexOf('moray');
    if (idx !== -1) {
        fns.push(function (req, res, next) {
            CONNECTION_CHECKS['moray'](opts, req, res, next);
        });
        connected.splice(idx, 1);
    }


    prepopulate.forEach(function (resource) {
        if (!PREPOPULATE_FNS.hasOwnProperty(resource)) {
            throw (
                new verror.VError(
                    'unknown resource for prepopulation, %s', resource));
        }

        fns.push(function (req, res, next) {
            PREPOPULATE_FNS[resource](opts, req, res, next);
        });
    });


    connected.forEach(function (service) {
        if (!CONNECTION_CHECKS.hasOwnProperty(service)) {
            throw (
                new verror.VError(
                    'unknown service for precondition check, %s', service));
        }

        fns.push(function (req, res, next) {
            CONNECTION_CHECKS[service](opts, req, res, next);
        });
    });

    return fns;
}

/**
 * Return CNAPI's service status details.
 *
 * @name Ping
 * @endpoint GET /ping
 * @section Miscellaneous API
 *
 * @example GET /ping
 *
 * @response 200 Object Status details.
 */

function ping(app, req, res, next) {
    var services = {
        workflow:
            (app.workflow.client &&
             app.workflow.connected) ? 'online' : 'offline',
        moray:
            (app.moray._morayClient &&
             app.moray.connected) ? 'online' : 'offline',
        amqp:
            (app.amqpConnection &&
             app.amqpConnection.connected) ? 'online' : 'offline'
    };
    res.send(200, {
        ready:
            services.workflow === 'online' &&
            services.moray === 'online' &&
            services.amqp === 'online',
        services: services
    });
    next();
}

function attachTo(http, app) {
    http.post(
        '/loglevel',
        function (req, res, next) {
            var level = req.params.level;
            app.getLog().debug('Setting loglevel to %s', level);
            app.getLog().level(level);
            res.send();
            return next();
        });

    http.get(
        '/loglevel',
        function (req, res, next) {
            res.send({ level: app.getLog().level() });
            return next();
        });

    http.get({path: '/ping', name: 'Ping'}, function (req, res, next) {
        ping(app, req, res, next);
    });

    http.get('/info', function (req, res, next) {
        var info = {};

        fs.readFile(path.join(__dirname, '..', '..', 'package.json'),
        function (error, data) {
            if (error) {
                next(new restify.InternalError(error.message));
                return;
            }
            var pkg = JSON.parse(data.toString());
            info.version = pkg.version;

            res.send(info);
            next();
        });
    });

    http.get('/diagnostics', function (req, res, next) {
        var send = {
            start_timestamp: app.start_timestamp,
            memory: process.memoryUsage()
        };

        var taskCallbacks = {};

        Object.keys(app.taskCallbacks).forEach(function (taskid) {
            taskCallbacks[taskid] = app.taskCallbacks[taskid].map(function (i) {
                return { id: i.id }; });
        });


        send.taskCallbacks = taskCallbacks;
        send.agent_handles_length = 0;
        send.agent_handles = [];

        var tks = app.getTaskClient();

        for (var uuid in tks.agentHandles) {
            send.agent_handles_length++;

            send.agent_handles.push({
                uuid: uuid,
                task_handles_length:
                    Object.keys(
                        tks.agentHandles[uuid].taskHandles).length,
                task_handles_uuid:
                    Object.keys(tks.agentHandles[uuid].taskHandles)
            });
        }

        res.send(send);
    });

    fw.attachTo(http, app);
    images.attachTo(http, app);
    nics.attachTo(http, app);
    platforms.attachTo(http, app);
    servers.attachTo(http, app);
    waitlist.attachTo(http, app);
    vms.attachTo(http, app);
    tasks.attachTo(http, app);
    allocator.attachTo(http, app);
    boot_params.attachTo(http, app);
    ur.attachTo(http, app);
    zfs.attachTo(http, app);
}

exports.attachTo = attachTo;
exports.ensure = ensure;
