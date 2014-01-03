var fs = require('fs');
var path = require('path');
var verror = require('verror');
var restify = require('restify');
var assert = require('assert-plus');


var boot_params = require('./boot_params');
var fw = require('./fw');
var ModelServer = require('../models/server');
var nics = require('./nics');
var platforms = require('./platforms');
var servers = require('./servers');
var waitlist = require('./waitlist');
var tasks = require('./tasks');
var ur = require('./ur');
var vms = require('./vms');
var zfs = require('./zfs');


var CONNECTION_CHECKS = {
    moray: ensureConnectedToMoray,
    amqp: ensureConnectedToAMQP,
    workflow: ensureConnectedToWorkflow
};

var PREPOPULATE_FNS = {
    server: prepopulateServer,
    vm: prepopulateVm
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

function prepopulateServer(opts, req, res, next) {
    assert.string(req.params.server_uuid, 'server_uuid');

    req.stash.server = new ModelServer(req.params.server_uuid);
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
                next(new restify.ResourceNotFoundError(errorMsg));
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
            req.stash = {};
            req.stash.app = opts.app;
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

    http.get('/ping', function (req, res, next) {
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
            agent_handles_length: 0,
            agent_handles: [],

        /**
         *  memwatch: {
         *      leaks: app.leaks,
         *      stats: app.stats,
         *      diff: app.diff
         *  },
         */

            memory: process.memoryUsage()
        };

        var tks = app.getTaskClient();

        for (var uuid in tks.agentHandles) {
            send.agent_handles_length++;

            send.agent_handles.push({
                uuid: uuid,
                task_handles_length:
                    Object.keys(tks.agentHandles[uuid].taskHandles).length,
                task_handles_uuid:
                    Object.keys(tks.agentHandles[uuid].taskHandles)
            });
        }

        send.waitlist_queues = {};

        Object.keys(app.waitlistDirector.activeTicketsByValues).forEach(
            function (k) {
                var t = app.waitlistDirector.activeTicketsByValues[k];

                send.waitlist_queues[k] = [];

                t.tickets.forEach(function (tuuid) {
                    send.waitlist_queues[k].push(
                        JSON.parse(JSON.stringify(
                        app.waitlistDirector.activeTicketsByUuid[tuuid])));
                });
            });


        send.active_waitlist_queues =
            app.waitlistDirector.activeTicketsByValues;




        res.send(send);
    });

    fw.attachTo(http, app);
    nics.attachTo(http, app);
    platforms.attachTo(http, app);
    servers.attachTo(http, app);
    waitlist.attachTo(http, app);
    vms.attachTo(http, app);
    tasks.attachTo(http, app);
    boot_params.attachTo(http, app);
    ur.attachTo(http, app);
    zfs.attachTo(http, app);
}

exports.attachTo = attachTo;
exports.ensure = ensure;
