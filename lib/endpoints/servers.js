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
var sprintf = require('sprintf').sprintf;
var validation = require('../validation/endpoints');

var ModelServer = require('../models/server');
var ModelPlatform = require('../models/platform');
var datasetEndpoints = require('./zfs');
var common = require('../common');
var verror = require('verror');

function Server() {}


Server.init = function () {
    Server.log = ModelServer.log;
};


/* BEGIN JSSTYLED */
/**
 * Returns Servers present in datacenter.
 *
 * @name ServerList
 * @endpoint GET /servers
 * @section Servers
 *
 * @param {String} uuids Comma seperated list of UUIDs to look up
 * @param {Boolean} setup Return only setup servers
 * @param {Boolean} headnode Return only headnodes
 * @param {String} hostname Return machine with given hostname
 * @param {String} extras Comma seperated values: vms, memory, sysinfo
 * @param {Number} limit Maximum number of results to show
 * @param {Number} offset Offset the subset of results returned
 *
 * @example GET /servers
 * @example GET /servers?uuids=uuid1,uuid2
 * @example GET /servers?setup=true
 * @example GET /servers?headnode=false
 *
 * @response 200 Array The returned servers
 */
/* END JSSTYLED */

Server.list = function (req, res, next) {
    var result;

    var rules = {
        'setup': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'reserved': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'headnode': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'hostname': ['optional', 'isStringType', 'isTrim'],
        'limit': ['optional', 'isNumberType'],
        'offset': ['optional', 'isNumberType'],
        'uuids': [
            ['optional', undefined],
            /*JSSTYLED*/
            ['regex', RegExp(/^[-a-z0-9A-Z]+(,[-a-z0-9A-Z]+)*$/i)]
        ]
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    async.waterfall([
        function (cb) {
            var options = {};
            options.wantFinal = true;

            options.uuid = req.params.uuids &&
                req.params.uuids.split(new RegExp('\s*,\s*', 'g'));
            options.setup = req.params.setup;
            options.reserved = req.params.reserved;
            options.headnode = req.params.headnode;
            options.hostname = req.params.hostname;
            options.default = false;

            // Set up paging
            ['limit', 'offset'].forEach(function (f) {
                if (req.params.hasOwnProperty(f)) {
                    options[f] = req.params[f];
                }
            });

            // Set up extras
            if (req.params.extras) {
                options.extras = { status: true };
                req.params.extras.split(',').forEach(function (f) {
                    options.extras[f] = true;
                });
            }

            req.log.debug(options, 'Searching for all servers');
            ModelServer.list(
                options,
                function (error, s) {
                    if (error) {
                        cb(error);
                        return;
                    }
                    req.log.debug({ servers: s }, 'Servers found');
                    if (!options.extras ||
                        (options.extras && !options.extras.sysinfo)) {

                        for (var i in s) {
                            delete s[i].sysinfo;
                        }
                    }
                    result = s;
                    cb();
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

        res.send(result);
        next();
        return;
    });
};


/* BEGIN JSSTYLED */
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
/* END JSSTYLED */

Server.get = function (req, res, next) {
    req.stash.server.getFinal(
        function (error, server) {
            res.send(server);
            next();
        });
};


/* BEGIN JSSTYLED */
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
 * @param {String} comments Any comments about the server
 * @param {Boolean} reserved Server is available for provisioning
 * @param {Number} reservation_ratio The reservation ratio
 * @param {Number} overprovision_ratio The overprovisioning ratio
 * @param {String} serial Serial device
 * @param {Number} serial_speed Serial speed value
 * @param {Boolean} setup True if server has been set up
 * @param {Boolean} setting_up True if server is in the process of setting up
 * @param {String} transitional_status The fallback status if not 'running'. For example, if the server has to reboot, this value may be set to 'rebooting'.
 * @param {Object} traits Server traits
 *
 * @example POST /servers/12494d5e-3960-4d65-a61a
 *          -d '{ "default_console": "vga", "setup", true }'
 *
 * @response 204 None The value was set successfuly
 */
/* END JSSTYLED */

Server.update = function (req, res, next) {
    var rules = {
        'boot_params': ['optional', 'isObjectType'],
        'boot_platform': ['optional', 'isStringType', 'isTrim'],
        'comments': ['optional', 'isStringType', 'isTrim'],
        'default_console': ['optional', 'isStringType', 'isTrim'],
        'nics': ['optional', 'isArrayType'],
        'overprovision_ratio': ['optional', 'isNumberType'],
        'rack_identifier': ['optional', 'isStringType', 'isTrim'],
        'reservation_ratio': ['optional', 'isNumberType'],
        'reserved': ['optional', 'isBooleanType'],
        'serial_speed': ['optional', 'isNumberType', 'isTrim'],
        'serial': ['optional', 'isStringType', 'isTrim'],
        'setting_up': ['optional', 'isBooleanType'],
        'setup': ['optional', 'isBooleanType'],
        'traits': ['optional', 'isObjectType'],
        'transitional_status': ['optional', 'isStringType', 'isTrim']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var attrs = [
        ['boot_params', Object],
        ['boot_platform', String],
        ['comments', String],
        ['default_console', String],
        ['overprovision_ratio', Number],
        ['rack_identifier', String],
        ['reservation_ratio', Number],
        ['reserved', Boolean],
        ['serial_speed', Number],
        ['serial', String],
        ['setting_up', Boolean],
        ['setup', Boolean],
        ['traits', Object],
        ['transitional_status', String]
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
            if (val === true) {
                change[param] = true;
            } else if (val === false) {
                change[param] = false;
            }
        } else if (type == Number) {
            change[param] = Number(val);
        } else {
            change[param] = val;
        }
    });

    async.waterfall([
        // If specified, ensure the boot_platform exists as a platform image on
        // the headnode.
        function (cb) {
            if (!change.boot_platform) {
                cb();
                return;
            }

            ModelPlatform.list({}, function (error, platforms) {
                if (error) {
                    cb(error);
                    return;
                }

                if (!platforms.hasOwnProperty(change.boot_platform)) {
                    cb(new verror.VError('failed to find given platform image,'
                        + ' %s', change.boot_platform));
                    return;
                }

                cb();
            });
        },

        // If modifying overprovision ratio, ensure the Server has no Vms
        function (cb) {
            if (!change.overprovision_ratio) {
                cb();
                return;
            }

            req.stash.server.cacheGetVms(function (error, vms) {
                if (error) {
                    cb(new verror.VError('failed to fetch vms'));
                    return;
                }

                if (vms && Object.keys(vms).length) {
                    var err = new verror.VError(
                        'overprovision_ratio may not be changed'
                        + ' if compute node has vms');
                    err.code = 409;

                    cb(err);
                    return;
                }

                cb();
            });
        },
        // If the server is not setup, we don't need to bother updating the
        // on-server configturation value.
        function (cb) {
            if (!req.params.overprovision_ratio) {
                cb();
                return;
            }

            req.stash.server.getRaw(function (error, raw) {
                if (!raw.setup) {
                    cb();
                    return;
                }

                ModelServer.getTaskClient().getAgentHandle(
                    'provisioner',
                    req.stash.server.uuid,
                    function (handle) {
                        handle.sendTask(
                            'server_overprovision_ratio',
                            { value: req.params.overprovision_ratio },
                            function (taskHandle) {
                                if (!taskHandle) {
                                    cb(new Error('hit max tasks limit'));
                                    return;
                                }
                                var taskerr;

                                taskHandle.on('event',
                                    function (eventName, msg) {
                                        if (eventName === 'error') {
                                            req.log.error(
                                                'Error received during task:'
                                                + ' %s', msg.error);
                                            taskerr = msg.error;
                                        } else if (eventName === 'finish') {
                                            if (taskerr) {
                                                cb(new Error(taskerr));
                                                return;
                                            } else {
                                                cb();
                                                return;
                                            }
                                        }
                                    });
                            });
                    });
            });
        }
    ],
    function (error) {
        if (error) {
            if (error.code) {
                next(
                    restify.codeToHttpError(error.code, error.message));
                return;
            }

            next(
                new restify.InternalError(error.message));
            return;
        }

        req.stash.server.modify(
            change,
            function (modifyError) {
                if (modifyError) {
                    next(new restify.InternalError(error.message));
                    return;
                }

                res.send(204);
                next();
                return;
            });
        });
};

/* BEGIN JSSTYLED */
/**
 * Reboot the server.
 *
 * @name ServerReboot
 * @endpoint POST /servers/:server\_uuid/reboot
 * @section Servers
 *
 * @response 204 Object Server reboot initiated
 * @response 500 None Error attempting to set up server
 */
/* END JSSTYLED */

Server.reboot = function (req, res, next) {
    req.stash.server.getRaw(function (error, rawserver) {
        req.stash.server.reboot(function (rebootError, jobUuid) {
            if (rebootError) {
                next(new restify.InternalError(rebootError.message));
                return;
            }
            res.send(202, { job_uuid: jobUuid });
            next();
            return;
        });
    });
};

/* BEGIN JSSTYLED */
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
/* END JSSTYLED */

Server.factoryReset = function (req, res, next) {
    req.stash.server.cacheGetVms(function (error, vms) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        if (vms && Object.keys(vms).length) {
            res.send(
                409, 'Server may not be reset because it has ' +
                Object.keys(vms).length +
                ' vms');
            next();
            return;
        } else {
            req.log.info(
                '%s had no VMs prior to factory-reset. Continuing.',
                req.stash.server.uuid);
        }


        req.stash.server.factoryReset(function (resetError, jobUuid) {
            if (resetError) {
                next(new restify.InternalError(resetError.message));
                return;
            }

            setTimeout(function () {
                req.stash.server.cacheDelVms(function () {});
            }, 10000);

            res.send(202, { job_uuid: jobUuid });
            next();
        });

    });
};


/* BEGIN JSSTYLED */
/**
 * Initiate the server setup process for a newly started server.
 *
 * @name ServerSetup
 * @endpoint PUT /servers/:server_uuid/setup
 * @section Servers
 * @param {Object} nics Nic parameters to update
 * @param {String} postsetup_script Script to run after setup has completed
 * @param {String} hostname Hostname to set for the specified server
 * @response 200 Object Setup initated, returns object containing workflow id
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

Server.setup = function (req, res, next) {
    var rules = {
        'nics': ['optional', 'isArrayType'],
        'postsetup_script': ['optional', 'isStringType'],
        'hostname': ['optional', 'isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var params = {};
    if (req.params.hasOwnProperty('nics')) {
        params.nics = req.params.nics;
    }

    if (req.params.hasOwnProperty('postsetup_script')) {
        params.postsetup_script = req.params.postsetup_script;
    }
    if (req.params.hasOwnProperty('hostname')) {
        params.hostname = req.params.hostname;
    }
    req.stash.server.getRaw(function (error, rawserver) {
        if (rawserver.setup) {
            res.send(204);
            next();
            return;
        }

        req.stash.server.setup(params, function (setupError, jobUuid) {
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


/* BEGIN JSSTYLED */
/**
 * Fetch a given server's sysinfo values and store them in the server object.
 *
 * @name ServerSysinfoRefresh
 * @endpoint POST /servers/:server_uuid/sysinfo-refresh
 * @section Servers
 *
 * @response 200 Object Sysinfo refresh initiated
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

Server.sysinfoRefresh = function (req, res, next) {
    req.log.info(
        'Querying Ur agent on %s for server for sysinfo',
        req.params.server_uuid);
    ModelServer.getUr().serverSysinfo(
        req.params.server_uuid,
        function (sysinfoerror, sysinfo) {
            if (sysinfoerror) {
                next(
                    new restify.InternalError(
                        sysinfoerror.message));
                return;
            }

            req.log.debug({ sysinfo: sysinfo }, 'Received sysinfo');

            req.stash.server.getRaw(function (geterror, server) {
                if (geterror) {
                    next(
                        new restify.InternalError(
                            geterror.message));
                    return;
                }
                server.sysinfo = sysinfo;

                req.log.debug('Writing new sysinfo to moray');

                req.stash.server.modify(server, function (moderror) {
                    if (moderror) {
                        next(
                            new restify.InternalError(
                                moderror.message));
                        return;
                    }
                    res.send(204);
                    next();
                });
            });
    });
};

/* BEGIN JSSTYLED */
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
/* END JSSTYLED */

Server.del = function (req, res, next) {
    req.stash.server.del(function (error) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }
        res.send(200);
        next();
    });
};


function attachTo(http, app) {
    Server.init();

    var ensure = require('../endpoints').ensure;

    // List servers
    http.get(
        { path: '/servers', name: 'ServerList' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray', 'redis']
        }),
        Server.list);

    // Get server
    http.get(
        { path: '/servers/:server_uuid', name: 'ServerGet' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray', 'redis']
        }),
        Server.get);

    // Update server
    http.post(
        { path: '/servers/:server_uuid', name: 'ServerUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray', 'redis', 'workflow']
        }),
        Server.update);

    // Setup server
    http.put(
        { path: '/servers/:server_uuid/setup', name: 'ServerSetup' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'redis', 'workflow']
        }),
        Server.setup);

    // Reboot server
    http.post(
        { path: '/servers/:server_uuid/reboot', name: 'ServerReboot' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'redis', 'workflow']
        }),
        Server.reboot);

    // Delete server
    http.del(
        { path: '/servers/:server_uuid', name: 'ServerDelete' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'redis', 'workflow']
        }),
        Server.del);

    // Refresh server sysinfo
    http.post({
        path: '/servers/:server_uuid/sysinfo-refresh',
        name: 'ServerSysinfoRefresh' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'redis', 'workflow']
        }),
        Server.sysinfoRefresh);

    // Factory-reset server
    http.put({
        path: '/servers/:server_uuid/factory-reset',
        name: 'ServerFactoryReset' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['amqp', 'moray', 'redis', 'workflow']
        }),
        Server.factoryReset);
}


exports.attachTo = attachTo;
