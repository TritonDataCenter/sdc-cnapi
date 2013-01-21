/*!
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints for interacting with compute nodes.
 *
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

/**
 * Returns Servers present in datacenter.
 *
 * @name ServerList
 * @endpoint GET /servers
 * @section Servers
 *
 * @param {String} uuids Comma seperated list of UUIDs to look up
 * @param {Boolean} setup Return only setup servers
 *
 * @example GET /servers
 * @example GET /servers?uuids=uuid1,uuid2
 * @example GET /servers/datacenter=foxy
 * @example GET /servers/setup=true
 *
 * @response 200 Array The returned servers
 */

Server.list = function (req, res, next) {
    var self = this;
    var result;

    async.waterfall([
        function (wf$callback) {
            var options = {};
            options.wantFinal = true;

            if (req.params.uuids) {
                options.uuid
                    = req.params.uuids.split(new RegExp('\s*,\s*', 'g'));
            }

            if (req.params.setup) {
                options.setup = isTrue(req.params.setup) ? true: false;
            }

            options.default = false;

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


/**
 * Look up a single Server by UUID.
 *
 * @name ServerGet
 * @endpoint GET /servers/:server\_uuid
 * @section Servers
 *
 * @example GET /servers/12494d5e-3960-4d65-a61a-0ca6252d6914
 *
 * @response 200 Object The server object>
 */

Server.get = function (req, res, next) {
    req.params.server.getFinal(function (error, server) {
        res.send(server);
        next();
    });
};


/**
 * Set the value of a Server's attribute.
 *
 * @name ServerUpdate
 * @endpoint POST /servers/:server_uuid
 * @section Servers
 *
 * @param {String} boot_platform The platform image to be used on next boot
 * @param {String} default_console Console type
 * @param {String} rack_identifier The id of the server's rack
 * @param {Boolean} reserved Server is available for provisioning
 * @param {String} serial Serial device
 * @param {Number} serial_speed Serial speed value
 * @param {Boolean} setup Indicate whether server is set up
 * @param {Boolean} setting_up Indicate whether server is in the process of setting up
 * @param {String} traits Server traits
 *
 * @example POST /servers/12494d5e-3960-4d65-a61a
 *          -d '{ "default_console": "vga", "setup", true }'
 *
 * @response 204 None The value was set successfuly
 */

Server.update = function (req, res, next) {
    var attrs = [
        ['boot_platform', String],
        ['boot_params', Object],
        ['default_console', String],
        ['reserved', Boolean],
        ['serial', String],
        ['serial_speed', Number],
        ['setup', Boolean],
        ['setting_up', Boolean],
        ['traits', Object],
        ['rack_identifier', String]
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


/**
 * Reset the server back to a factory state.
 *
 * @name ServerFactoryReset
 * @endpoint PUT /servers/:server\_uuid/factory-reset
 * @section Servers
 *
 * @response 204 Object Setup initated, returns object containing workflow id
 * @response 500 None Error attempting to set up server
 */

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


/**
 * Initiate the server setup process for a newly started server.
 *
 * @name ServerSetup
 * @endpoint PUT /servers/:server_uuid/setup
 * @section Servers
 *
 * @response 200 Object Setup initated, returns object containing workflow id
 * @response 500 None Error while processing request
 */

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

/**
 * Remove all references to given server. Does not change anything on the
 * actual server.
 *
 * @name ServerDelete
 * @endpoint DELETE /servers/:server_uuid
 * @section Servers
 *
 * @response 204 None Server was deleted successfully
 * @response 500 Error Could not process request
 */

Server.del = function (req, res, next) {
    req.params.server.del(function (error) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }
        res.send(200);
        next();
    });
};


function attachTo(http, model) {
    Server.init();

    var ensure = require('../endpoints').ensure;

    var listBefore = ensure({
        connectionTimeoutSeconds: 60 * 60,
        model: model,
        connected: ['amqp', 'moray', 'redis', 'workflow']
    });

    var getBefore = ensure({
        connectionTimeoutSeconds: 60 * 60,
        model: model,
        prepopulate: ['server'],
        connected: ['amqp', 'moray', 'redis', 'workflow']
    });

    // List servers
    http.get(
        { path: '/servers', name: 'ServerList' },
        listBefore, Server.list);

    // Get server
    http.get(
        { path: '/servers/:server_uuid', name: 'ServerGet' },
        getBefore, Server.get);

    // Update server
    http.post(
        { path: '/servers/:server_uuid', name: 'ServerUpdate' },
        getBefore, Server.update);

    // Setup server
    http.put(
        { path: '/servers/:server_uuid/setup', name: 'ServerSetup' },
        getBefore, Server.setup);

    // Setup server
    http.del(
        { path: '/servers/:server_uuid', name: 'ServerDelete' },
        getBefore, Server.del);

    // Factory-reset server
    http.put({
        path: '/servers/:server_uuid/factory-reset',
        name: 'ServerFactoryReset' },
        getBefore, Server.factoryReset);
}


exports.attachTo = attachTo;
