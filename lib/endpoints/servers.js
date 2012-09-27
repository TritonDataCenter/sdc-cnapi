var async = require('async');
var restify = require('restify');
var fs = require('fs');
var util = require('util');
var ModelServer = require('../models/server');
var datasetEndpoints = require('./zfs');


function Server() {}


Server.init = function () {
    Server.log = ModelServer.log;
};


Server.list = function (req, res, next) {
    var self = this;
    var result;

    async.waterfall([
        function (wf$callback) {
            var options = {};
            options.wantCache = true;
            if (req.params.uuids) {
                /*JSSTYLED*/
                options.uuid = req.params.uuids.split(/\s*,\s*/g);
            }

            if (req.params.setup) {
                options.setup = req.params.setup;
            }

            if (req.params.headnode) {
                options.headnode = req.params.headnode;
            }

            self.log.info(options, 'Searching for all servers');
            ModelServer.list(
                options,
                function (error, s) {
                    if (error) {
                        wf$callback(error);
                        return;
                    }
                    self.log.info(util.inspect(s), 'Servers found');
                    result = s;
                    wf$callback();
                    return;
                });
        }
    ],
    function (error) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }

        if (!result || !result.length) {
            res.send(404);
            next();
            return;
        }

        res.send(result);
        next();
        return;
    });
};


Server.get = function (req, res, next) {
    res.send(req.params.serverAttributes);
    next();
};


Server.update = function (req, res, next) {
    var attrs = [
        'default_console',
        'reserved',
        'serial',
        'serial_speed',
        'setup',
        'boot_platform'
    ];

    var changes = [];

    attrs.forEach(function (k) {
        if (typeof (req.params[k]) === 'undefined') {
            return;
        }

        var change = { type: 'replace', modification: {} };
        change.modification[k] = req.params[k].toString();
        changes.push(change);
    });

    req.params.server.modify(
        changes,
        function (error) {
            if (error) {
                next(new restify.InternalError(error.message));
                return;

            }

            res.send(204);
            next();
            return;
        });
};


Server.factoryReset = function (req, res, next) {
    var self = this;

    req.params.server.cacheGetVms(function (error, vms) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }


        if (vms && Object.keys(vms).length) {
            res.send(
                403, 'Server may not be reset because it has ' +
                Object.keys(vms).length +
                ' vms');
            next();
            return;
        } else {
            self.log.info(
                '%s had no VMs prior to factory-reset. Continuing.',
                req.params.server.uuid);
        }


        req.params.server.factoryReset(function (resetError, jobUuid) {
            if (resetError) {
                next(new restify.InternalError(resetError.message));
                return;
            }

            setTimeout(function () {
                req.params.server.cacheDelVms(function () {});
            }, 10000);

            res.send(202, { job_uuid: jobUuid });
            next();
        });

    });
};


Server.setup = function (req, res, next) {
    this.log.info(req.params.serverAttributes);
    if (req.params.serverAttributes.setup) {
        res.send(204);
        next();
        return;
    }

    req.params.server.setup(function (setupError, jobUuid) {
        if (setupError) {
            next(
                new restify.InternalError(
                    setupError.message));
            return;
        }
        res.send(202, { job_uuid: jobUuid });
        next();
        return;
    });
};


function attachTo(http, model) {
    Server.init();

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

                try {
                    req.params.serverAttributes.sysinfo
                        = JSON.parse(req.params.serverAttributes.sysinfo);
                }
                catch (e) {
                    req.params.serverAttributes.sysinfo = {};
                }

                next();
            });
        }
    ];

    // List servers
    http.get(
        { path: '/servers', name: 'ListServers' },
        before, Server.list);

    // Get server
    http.get(
        { path: '/servers/:server_uuid', name: 'GetServer' },
        before, Server.get);

    // Update server
    http.post(
        { path: '/servers/:server_uuid', name: 'UpdateServer' },
        before, Server.update);

    // Setup server
    http.put(
        { path: '/servers/:server_uuid/setup', name: 'SetupServer' },
        before, Server.setup);

    // Factory-reset server
    http.put({
        path: '/servers/:server_uuid/factory-reset',
        name: 'FactoryResetServer' },
        before, Server.factoryReset);
}


exports.attachTo = attachTo;
