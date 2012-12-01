/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This file contains all the Compute Server logic, used to interface with the
 * server as well as it's stored representation in the backend datastores.
 */

var async = require('async');
var restify = require('restify');
var fs = require('fs');
var util = require('util');

var ModelServer = require('../models/server');
var datasetEndpoints = require('./zfs');
var common = require('../common');

function Server() {}


Server.init = function () {
    Server.log = ModelServer.log;
};


function isTrue(val) {
    return val === 'true';
}

Server.list = function (req, res, next) {
    var self = this;
    var result;

    async.waterfall([
        function (wf$callback) {
            var options = {};
            options.wantFinal = true;

            if (req.params.uuids) {
                /*JSSTYLED*/
                options.uuid = req.params.uuids.split(/\s*,\s*/g);
            }

            if (req.params.setup) {
                options.setup
                     = isTrue(req.params.setup) ? true: false;
            }

            if (req.params.headnode) {
                options.headnode
                     = isTrue(req.params.headnode) ? true : false;
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
    req.params.server.getFinal(function (error, server) {
        res.send(server);
        next();
    });
};


Server.update = function (req, res, next) {
    var attrs = [
        ['boot_platform', String],
        ['default_console', String],
        ['reserved', Boolean],
        ['serial', Number],
        ['serial_speed', Number],
        ['setup', Boolean],
        ['traits', Object]
    ];

    var change = {};

    attrs.forEach(function (i) {
        var param = i[0];
        var type =  i[1];
        var val = req.params[param];

        if (typeof (val) === 'undefined') {
            return;
        }

        if (type == String) {
            change[param] = val;
        } else if (type == Boolean) {
            if (val === 'true') {
                change[param] = true;
            } else if (val === 'false') {
                change[param] = false;
            } else {
                // Error!
                change[param] = val;
            }
        } else if (type == Number) {
            change[param] = Number(val);
        } else {
            change[param] = val;
        }
    });


    req.params.server.modify(
        change,
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
    req.params.server.getRaw(function (error, rawserver) {
        if (rawserver.setup) {
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
    });
};


function attachTo(http, model) {
    Server.init();

    var ensure = require('../endpoints').ensure;

    var listBefore = ensure({
        connectionTimeoutSeconds: 60 * 60,
        model: model,
        connected: ['amqp', 'moray', 'redis']
    });

    var getBefore = ensure({
        connectionTimeoutSeconds: 60 * 60,
        model: model,
        prepopulate: ['server'],
        connected: ['amqp', 'moray', 'redis']
    });

    // List servers
    http.get(
        { path: '/servers', name: 'ListServers' },
        listBefore, Server.list);

    // Get server
    http.get(
        { path: '/servers/:server_uuid', name: 'GetServer' },
        getBefore, Server.get);

    // Update server
    http.post(
        { path: '/servers/:server_uuid', name: 'UpdateServer' },
        getBefore, Server.update);

    // Setup server
    http.put(
        { path: '/servers/:server_uuid/setup', name: 'SetupServer' },
        getBefore, Server.setup);

    // Factory-reset server
    http.put({
        path: '/servers/:server_uuid/factory-reset',
        name: 'FactoryResetServer' },
        getBefore, Server.factoryReset);
}


exports.attachTo = attachTo;
