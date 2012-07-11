// Copyright 2012 Joyent, Inc.  All rights reserved.

var assert = require('assert');
var querystring = require('querystring');
var restify = require('restify');
var format = require('util').format;



// --- Globals

var MONITOR_BASE_FMT = '/pub/%s/monitors';
var MONITOR_FMT = MONITOR_BASE_FMT + '/%s';
var PROBE_BASE_FMT = MONITOR_FMT + '/probes/';
var PROBE_FMT = PROBE_BASE_FMT + '%s';



// --- Exported Amon Client

/**
 * Constructor
 *
 * Note that in options you can pass in any parameters that the restify
 * RestClient constructor takes (for example retry/backoff settings).
 *
 * @param {Object} options
 *    - url {String} Amon Master location.
 *    - ... any other options allowed to `restify.createJsonClient`
 *
 */
function Amon(options) {
    if (!options)
        throw new TypeError('options required');
    if (!options.url)
        throw new TypeError('options.url (String) is required');

    this.client = restify.createJsonClient(options);
}


/**
 * Ping Amon server.
 *
 * @param {Function} callback : call of the form f(err, pong).
 */
Amon.prototype.ping = function (callback) {
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (Function) is required');

    return this.client.get('/ping', function (err, req, res, pong) {
        if (err) {
            return callback(err);
        }
        return callback(null, pong);
    });
};


/**
 * Lists monitors by user
 *
 * @param {String} user : the user uuid.
 * @param {Function} callback : call of the form f(err, monitors).
 */
Amon.prototype.listMonitors = function (user, callback) {
    if (!user)
        throw new TypeError('user (String) is required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (Function) is required');

    var path = format(MONITOR_BASE_FMT, user);
    return this.client.get(path, function (err, req, res, obj) {
        if (err) {
            return callback(err);
        }
        return callback(null, obj);
    });
};


/**
 * Gets monitor by user and monitor name.
 *
 *
 * @param {String} user : the user uuid.
 * @param {String} monitorName : the name of the monitor.
 * @param {Function} callback of the form f(err, monitor).
 */
Amon.prototype.getMonitor = function (user, monitorName, callback) {
    if (!user)
        throw new TypeError('user is required');
    if (!monitorName)
        throw new TypeError('monitorName is required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (Function) is required');

    var path = format(MONITOR_FMT, user, monitorName);
    return this.client.get(path, function (err, req, res, obj) {
        if (err) {
            return callback(err);
        }
        return callback(null, obj);
    });
};


/**
 * Creates a monitor for a user
 *
 * @param {String} user : user uuid.
 * @param {String} name : monitor name.
 * @param {Object} monitor : The monitor, should contain the following
 *    `{"contacts" : ["email"]}`.
 * @param {Function} callback of the form f(err, account).
 */
Amon.prototype.putMonitor = function (user, name, monitor, callback) {
    if (!user)
        throw new TypeError('user is required');
    if (!name)
        throw new TypeError('name is required (object)');
    if (!monitor)
        throw new TypeError('monitor is required (object)');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (Function) is required');

    var path = format(MONITOR_FMT, user, name);
    return this.client.put(path, monitor, function (err, req, res, obj) {
        if (err) {
            return callback(err);
        }
        return callback(null, obj);
    });
};


/**
 * Deletes a monitor from Amon by monitor name.
 *
 * @param {String} user : the user uuid.
 * @param {String} monitorName : the name of the monitor.
 * @param {Function} callback of the form f(err).
 */
Amon.prototype.deleteMonitor = function (user, monitorName, callback) {
    if (!user)
        throw new TypeError('user is required');
    if (!monitorName)
        throw new TypeError('monitorName is required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (Function) is required');

    var path = format(MONITOR_FMT, user, monitorName);
    return this.client.del(path, function (err, req, res) {
        if (err) {
            return callback(err);
        }
        return callback(null);
    });
};


/**
 * List probes by user and monitor name.
 *
 * @param {String} user : the user uuid.
 * @param {String} monitorName : the name of the monitor.
 * @param {Function} callback : call of the form f(err, probes).
 */
Amon.prototype.listProbes = function (user, monitorName, callback) {
    if (!user)
        throw new TypeError('user is required');
    if (!monitorName)
        throw new TypeError('monitorName is required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (Function) is required');

    var path = format(PROBE_BASE_FMT, user, monitorName);
    return this.client.get(path, function (err, req, res, obj) {
        if (err) {
            return callback(err);
        }
        return callback(null, obj);
    });
};


/**
 * Creates a probe for a monitor.
 *
 * @param {String} user : The user UUID.
 * @param {String} monitorName : The name of the monitor.
 * @param {String} name : probe name.
 * @param {Object} probe : The probe data.
 */
Amon.prototype.putProbe = function (user, monitorName, name, probe, callback) {
    if (!user)
        throw new TypeError('user is required');
    if (!monitorName)
        throw new TypeError('monitorName is required');
    if (!name)
        throw new TypeError('name is required');
    if (!probe)
        throw new TypeError('probe is required (object)');

    var path = format(PROBE_FMT, user, monitorName, name);
    return this.client.put(path, probe, function (err, req, res, obj) {
        if (err) {
            return callback(err);
        }
        return callback(null, obj);
    });
};


/**
 * Deletes a probe from Amon.
 *
 * @param {String} user : the user uuid.
 * @param {String} monitorName : the name of the monitor.
 * @param {String} probeName : the name of the probe.
 * @param {Function} callback of the form f(err).
 */
Amon.prototype.deleteProbe = function (user, monitorName,
                                      probeName, callback) {
    if (!user)
        throw new TypeError('user is required');
    if (!monitorName)
        throw new TypeError('monitorName is required');
    if (!probeName)
        throw new TypeError('probeName is required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (Function) is required');

    var path = format(PROBE_FMT, user, monitorName, probeName);
    return this.client.del(path, function (err, req, res) {
        if (err) {
            return callback(err);
        }

        return callback(null);
    });
};


/**
 * Gets probe.
 *
 * @param {String} user : the user uuid.
 * @param {String} monitorName : the name of the monitor.
 * @param {String} probeName : the name of the probe.
 * @param {Function} callback of the form f(err, account).
 */
Amon.prototype.getProbe = function (user, monitorName, probeName, callback) {
    if (!user)
        throw new TypeError('user is required');
    if (!monitorName)
        throw new TypeError('monitorName is required');
    if (!probeName)
        throw new TypeError('probeName is required');
    if (!callback || typeof (callback) !== 'function')
        throw new TypeError('callback (Function) is required');

    var path = format(PROBE_FMT, user, monitorName, probeName);
    return this.client.get(path, function (err, req, res, obj) {
        if (err) {
            return callback(err);
        }
        return callback(null, obj);
    });
};




module.exports = Amon;
