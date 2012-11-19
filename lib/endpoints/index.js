var boot_params = require('./boot_params');
var platforms = require('./platforms');
var servers = require('./servers');
var tasks = require('./tasks');
var ur = require('./ur');
var vms = require('./vms');
var zfs = require('./zfs');
var verror = require('verror');
var restify = require('restify');

var CONNECTION_CHECKS = {
    moray: ensureConnectedToMoray,
    amqp: ensureConnectedToAMQP,
    redis: ensureConnectedToRedis
};

function ensureConnectedToMoray(opts, req, res, next) {
    opts.log.debug('ensuring connected to Moray');
    if (!opts.model.moray.connected) {
        next(
            new restify.InternalError(
                'Precondition failed: no connection moray'));
    }
    next();
}

function ensureConnectedToAMQP(opts, req, res, next) {
    opts.log.debug('ensuring connected to AMQP');
    next();
}

function ensureConnectedToRedis(opts, req, res, next) {
    opts.log.debug('ensuring connected to Redis');
    next();
}

function ensureConnectionTimeout(opts, req, res, next) {
    opts.log.debug('ensuring timeout set');
    req.connection.setTimeout(opts.timeout);
    next();
}

function ensure(opts) {
    var checks = [];

    opts.log = opts.model.getLog();
    opts.timeout = opts.timeout || 60 * 60;
    // Override timeout
    checks.push(function (req, res, next) {
        ensureConnectionTimeout(opts, req, res, next);
    });

    var connected = opts.connected || [];

    Object.keys(connected).forEach(function (service) {
        if (!CONNECTION_CHECKS.hasOwnProperty(service)) {
            throw (
                new verror.VError(
                    'unknown service for precondition check, %s', service));
        }

        checks.push(function (req, res, next) {
            CONNECTION_CHECKS[service](opts, req, res, next);
        });
    });

    return checks;
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
