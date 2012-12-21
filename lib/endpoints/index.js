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
    if (!opts.model.moray.connected) {
        next(
            new restify.InternalError(
                'Precondition failed: no connection moray'));
    }
    next();
}

function ensureConnectedToAMQP(opts, req, res, next) {
    next();
}

function ensureConnectedToRedis(opts, req, res, next) {
    next();
}

function ensureConnectedToWorkflow(opts, req, res, next) {
    if (!opts.model.workflow.connected) {
        next(
            new restify.InternalError(
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

    req.params.server = new ModelServer(req.params.server_uuid);
    req.params.server.getRaw(function (error, server) {
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
    req.params.server.cacheCheckVmExists(
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

            req.params.vm = req.params.server.getVM(uuid);
            next();
        });
}

function ensure(opts) {
    var fns = [];

    opts.log = opts.model.getLog();
    opts.connectionTimeoutSeconds = opts.connectionTimeoutSeconds || 60 * 60;
    // Override timeout
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


function attachTo(http, model) {
    http.post(
        '/loglevel',
        function (req, res, next) {
            var level = req.params.level;
            model.log.debug('Setting loglevel to %s', level);
            model.log.level(level);
            res.send();
            return next();
        });

    http.get(
        '/loglevel',
        function (req, res, next) {
            res.send({ level: model.log.level() });
            return next();
        });

    fw.attachTo(http, model);
    platforms.attachTo(http, model);
    servers.attachTo(http, model);
    vms.attachTo(http, model);
    tasks.attachTo(http, model);
    boot_params.attachTo(http, model);
    ur.attachTo(http, model);
    zfs.attachTo(http, model);
}

exports.attachTo = attachTo;
exports.ensure = ensure;
