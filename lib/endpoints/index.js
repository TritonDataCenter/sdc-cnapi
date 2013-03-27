var boot_params = require('./boot_params');
var fw = require('./fw');
var platforms = require('./platforms');
var servers = require('./servers');
var tasks = require('./tasks');
var ur = require('./ur');
var vms = require('./vms');
var zfs = require('./zfs');
var verror = require('verror');
var restify = require('restify');
var ModelServer = require('../models/server');
var assert = require('assert-plus');

var CONNECTION_CHECKS = {
    moray: ensureConnectedToMoray,
    amqp: ensureConnectedToAMQP,
    redis: ensureConnectedToRedis,
    workflow: ensureConnectedToWorkflow
};

var PREPOPULATE_FNS = {
    server: prepopulateServer,
    vm: prepopulateVm
};

function ensureConnectedToMoray(opts, req, res, next) {
    if (!opts.app.getModel().moray.connected) {
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

function ensureConnectedToRedis(opts, req, res, next) {
    if (!opts.app.getModel().redis.isConnected()) {
        next(new restify.InternalError(
            'Precondition failed: no connection to Redis'));
        return;
    }
    next();
}

function ensureConnectedToWorkflow(opts, req, res, next) {
    if (!opts.app.getModel().workflow.connected) {
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

    req.stash.server = new ModelServer(req.params.server_uuid);
    req.stash.server.getRaw(function (error, server) {
        // Check if any servers were returned
        if (!server) {
            var errorMsg = 'Server ' + req.params.server_uuid + ' not found';
            next(new restify.ResourceNotFoundError(errorMsg));
            return;
        }
        next();
    });
}

function prepopulateVm(opts, req, res, next) {
    assert.string(req.params.uuid, 'uuid');

    var uuid = req.params.uuid;
    req.stash.server.cacheCheckVmExists(
        req.params.uuid,
        function (cacheError, exists) {
            var errorMsg;
            if (!exists) {
                errorMsg = 'VM ' + uuid + ' not found';
                next(
                    new restify.ResourceNotFoundError(
                        errorMsg));
                    return;
            }

            req.stash.vm = req.stash.server.getVM(uuid);
            next();
        });
}

function ensure(opts) {
    var fns = [];

    opts.log = opts.app.getLog();
    opts.connectionTimeoutSeconds = opts.connectionTimeoutSeconds || 60 * 60;

    // Override timeout
    fns.push(function (req, res, next) {
        if (!req.stash) {

            if (!opts.app.getModel()) {
                res.send(500, 'CNAPI model not yet initialized');
            } else {
                req.stash = {};
                req.stash.app = opts.app;
                req.stash.model = opts.app.getModel();
            }
        }
        next();
    });

    fns.push(function (req, res, next) {
        ensureConnectionTimeout(opts, req, res, next);
    });

    var connected = opts.connected || {};
    var prepopulate = opts.prepopulate || [];

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

    return fns;
}

/**
 * Return CNAPI's service status details.
 *
 * @name Ping
 * @endpoint GET /ping
 * @section Ping
 *
 * @example GET /ping
 *
 * @response 200 Object Status details.
 */

function ping(app, req, res, next) {
    var services = {
        redis:
            (app.getModel().redis.isConnected()) ? 'online' : 'offline',
        workflow:
            (app.getModel().workflow.client &&
             app.getModel().workflow.connected) ? 'online' : 'offline',
        moray:
            (app.getModel().moray._morayClient &&
             app.getModel().moray.connected) ? 'online' : 'offline',
        amqp:
            (app.amqpConnection &&
             app.amqpConnection.connected) ? 'online' : 'offline'
    };
    res.send(200, {
        ready:
            services.redis === 'online' &&
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

    http.get('/ping', function (req, res, next) {
        ping(app, req, res, next);
    });

    fw.attachTo(http, app);
    platforms.attachTo(http, app);
    servers.attachTo(http, app);
    vms.attachTo(http, app);
    tasks.attachTo(http, app);
    boot_params.attachTo(http, app);
    ur.attachTo(http, app);
    zfs.attachTo(http, app);
}

exports.attachTo = attachTo;
exports.ensure = ensure;
