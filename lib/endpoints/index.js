/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var fs = require('fs');
var util = require('util');
var path = require('path');
var VError = require('verror');
var restify = require('restify');
var assert = require('assert-plus');
var jsprim = require('jsprim');


var ModelImage = require('../models/image');
var ModelServer = require('../models/server');

var allocations = require('./allocations');
var errors = require('../errors');
var boot_params = require('./boot_params');
var images = require('./images');
var nics = require('./nics');
var platforms = require('./platforms');
var servers = require('./servers');
var tasks = require('./tasks');
var ur = require('./ur');
var vms = require('./vms');
var waitlist = require('./waitlist');
var zfs = require('./zfs');


var CONNECTION_CHECKS = {
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


/* BEGIN JSSTYLED */
/**
 * Restify handler to ensure the requested server has status "running".
 *
 * @param {Object} opts options object
 * @param {Object} req Restify `req` object
 * @param {Object} res Restify `res` object
 */
/* END JSSTYLED */

function ensureServerRunning(opts, req, res, next) {
    assert.object(opts, 'opts');
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');
    req.stash.server.getRaw(function (err, serverobj) {
        if (serverobj.status !== 'running') {
            next(new errors.ServerNotRunningError());
            return;
        } else  {
            next();
        }
    });
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

/* BEGIN JSSTYLED */
/**
 * `ensure()` returns an array of functions. This array is to be passed in when
 * registering restify endpoint handlers. The functions returned correspond to
 * directives passed in by the caller, checking for running status, ensuring
 * that connection dependencies are available and in working order, and certain
 * attributes are populated.
 *
 * @param {Object} opts options object
 * @param {Object} opts.connectionTimeoutSeconds restify connection timeout
 * @param {Object} opts.app CNAPI `App` obkect
 * @param {Array} opts.prepopulate Prepopulate stash with CNAPI objects (server, vm)
 * @param {Array} opts.connected Asserts CNAPI is connected to service dependencies (moray, workflow, amqp)
 */
/* END JSSTYLED */

function ensure(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.optionalNumber(opts.connectionTimeoutSeconds,
                    'opts.connectionTimeoutSeconds');
    assert.optionalArray(opts.prepopulate, 'opts.prepopulate');
    assert.optionalArray(opts.connected, 'opts.connected');

    // Copy `opts` so we don't modify the caller's version
    opts = jsprim.deepCopy(opts);

    var fns = [];

    opts.log = opts.app.getLog();
    opts.connectionTimeoutSeconds = opts.connectionTimeoutSeconds || 60 * 60;

    if (opts.serverRunning) {
        var warning =
            'ensure `serverRunning` adding \"server\" to `prepopulate`';
        if (!opts.prepopulate) {
            opts.log.warn(warning);
            opts.prepopulate = ['server'];
        } else if (opts.prepopulate.indexOf('server') === -1) {
            opts.log.warn(warning);
            opts.prepopulate.push('server');
        }
    }

    // override timeout
    fns.push(function handlerEnsureStash(req, res, next) {
        if (!req.stash) {
            req.stash = {};
            req.stash.app = opts.app;
        }
        next();
    });

    fns.push(function handlerEnsureConnectionTimeout(req, res, next) {
        ensureConnectionTimeout(opts, req, res, next);
    });

    var connected = opts.connected || [];
    var prepopulate = opts.prepopulate || [];

    // If we're checking moray, do it first.
    var idx = connected.indexOf('moray');
    if (idx !== -1) {
        fns.push(function handlerEnsureConnectionMoray(req, res, next) {
            CONNECTION_CHECKS['moray'](opts, req, res, next);
        });
        connected.splice(idx, 1);
    }


    /**
     * The loops below loop over the `prepopulate` and `connected` arrays. Here
     * we create handlers used for checking connections and prepopulating
     * certain values (on an endpoint by endpoint basis) prior to the request
     * being serviced by the main restify handler.
     *
     * We use `Object.defineProperty()` to dynamically set the `name` of the
     * function which will act as the handler. The function name is used during
     * logging and tracing. If we don't name these functions they get generic
     * names (handler-0 ... handler-n) which are not very useful.
     */

    function makeHandler(opts_, name, functions, which) {
        var f = function (req, res, next) {
            functions[which](opts_, req, res, next);
        };
        Object.defineProperty(f, 'name', { value: name });
        return f;
    }

    prepopulate.forEach(function (resource) {
        if (!PREPOPULATE_FNS.hasOwnProperty(resource)) {
            throw (
                new VError(
                    'unknown resource for prepopulation, %s', resource));
        }

        // create handler
        var handlerName = 'handlerEnsure' + (resource.charAt(0).toUpperCase() +
                                      resource.slice(1)) + 'Prepopulated';
        fns.push(makeHandler(opts, handlerName, PREPOPULATE_FNS, resource));
    });


    connected.forEach(function (service) {
        if (!CONNECTION_CHECKS.hasOwnProperty(service)) {
            throw (
                new VError(
                    'unknown service for precondition check, %s', service));
        }

        // create handler
        var handlerName = 'handlerEnsure' + (service.charAt(0).toUpperCase() +
                                      service.slice(1)) + 'Connected';
        fns.push(makeHandler(opts, handlerName, CONNECTION_CHECKS, service));
    });

    if (opts.serverRunning) {
        fns.push(function handlerEnsureServerRunning(req, res, next) {
            ensureServerRunning(opts, req, res, next);
        });
    }

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
            taskCallbacks[taskid] =
                app.taskCallbacks[taskid].callbacks.map(function (i) {
                    return { id: i.id }; });
                });


        send.taskCallbacks = taskCallbacks;

        res.send(send);
    });

    images.attachTo(http, app);
    nics.attachTo(http, app);
    platforms.attachTo(http, app);
    servers.attachTo(http, app);
    waitlist.attachTo(http, app);
    vms.attachTo(http, app);
    tasks.attachTo(http, app);
    allocations.attachTo(http, app);
    boot_params.attachTo(http, app);
    ur.attachTo(http, app);
    zfs.attachTo(http, app);
}

exports.attachTo = attachTo;
exports.ensure = ensure;
