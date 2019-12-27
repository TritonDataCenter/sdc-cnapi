/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 *
 * HTTP endpoints for interacting with compute nodes.
 *
 */

var assert = require('assert-plus');
var async = require('async');
var qs = require('qs');
var restify = require('restify');
var semver = require('semver');
var sprintf = require('sprintf').sprintf;
var vasync = require('vasync');
var VError = require('verror');

var Designation = require('../designation');
var errors = require('../errors');
var ModelPlatform = require('../models/platform');
var ModelServer = require('../models/server');
var validation = require('../validation/endpoints');


// ---- globals/constants

var SERVER_LIST_MIN_LIMIT = 1;
var SERVER_LIST_MAX_LIMIT = 1000;

var TASK_COMMAND_EXECUTE_MIN_VERSON = '2.6.0';
var TASK_SERVER_REBOOT_MIN_VERSION = '2.11.0';
var TASK_SERVER_SYSINFO_MIN_VERSION = '2.10.0';

// --- helpers

// When 'prepopulate' has 'server', we'll have req.stash.server which will
// include the server.agents property. This function can be used to pass in
// the req.stash.server and get back an object with cn-agent's properties
// if this server has cn-agent in its server.agents.
function getCnAgentFromStashedServer(stashedServer) {
    var agent;
    var cnAgent = {};
    var idx;
    var server = stashedServer ? stashedServer.value : undefined;

    if (!server || !Array.isArray(server.agents)) {
        return cnAgent;
    }

    for (idx = 0; idx < server.agents.length; idx++) {
        agent = server.agents[idx];
        if (agent.name === 'cn-agent') {
            cnAgent = agent;
            break;
        }
    }

    return cnAgent;
}


// ---- exports

function Server() {}


/* BEGIN JSSTYLED */
/**
 * Returns Servers present in datacenter.
 *
 * @name ServerList
 * @endpoint GET /servers
 * @section Server API
 *
 * @param {String} uuids Comma seperated list of UUIDs to look up
 * @param {Boolean} setup Return only setup servers
 * @param {Boolean} headnode Return only headnodes
 * @param {Boolean} reserved Return only reserved servers
 * @param {Boolean} reservoir Return only reservoir servers
 * @param {String} hostname Return machine with given hostname
 * @param {String} extras Comma seperated values: agents, vms, memory, disk, sysinfo, capacity, all
 * @param {Integer} limit Maximum number of results to return. It must be between 1-1000, inclusive. Defaults to 1000 (the maxmimum allowed value).
 * @param {Integer} offset Offset the subset of results returned
 *
 * @example GET /servers
 * @example GET /servers?uuids=uuid1,uuid2
 * @example GET /servers?setup=true
 * @example GET /servers?headnode=false
 *
 * @response 200 Array The returned servers
 */
/* END JSSTYLED */

Server.list = function handlerSeverList(req, res, next) {
    var result;

    var rules = {
        'setup': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'extras': [
            ['optional', undefined],
            /*JSSTYLED*/
            ['regex', RegExp(/^[a-zA-Z_]+(,[a-zA-Z_]+)*$/i)]
        ],
        'reserved': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'reservoir': [
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
        'limit': ['optional', 'isInt'],
        'offset': ['optional', 'isInt'],
        'uuids': [
            ['optional', undefined],
            /*JSSTYLED*/
            ['regex', RegExp(/^[-a-z0-9A-Z]+(,[-a-z0-9A-Z]+)*$/i)]
        ]
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    var limit;
    if (req.params.limit !== undefined) {
        limit = Number(req.params.limit);
        if (limit < SERVER_LIST_MIN_LIMIT || SERVER_LIST_MAX_LIMIT < limit) {
            res.send(400, validation.formatValidationErrors([ {
                param: 'limit',
                msg: 'limit must be in the range ' + SERVER_LIST_MIN_LIMIT
                    + '-' + SERVER_LIST_MAX_LIMIT + ' (inclusive)'
            }]));
            next();
            return;
        }
    }

    async.waterfall([
        function (cb) {
            var options = {};

            options.uuid = req.params.uuids &&
                req.params.uuids.split(new RegExp('\s*,\s*', 'g'));
            options.setup = req.params.setup;
            options.reserved = req.params.reserved;
            options.headnode = req.params.headnode;
            options.reservoir = req.params.reservoir;
            options.hostname = req.params.hostname;
            options.default = false;

            // Set up paging
            if (limit !== undefined) {
                options.limit = limit; // Already converted to a Number above.
            }
            if (req.params.offset !== undefined) {
                options.offset = Number(req.params.offset);
            }

            // Set up extras
            if (req.params.extras) {
                var extras = { status: true, last_heartbeat: true };
                options.extras = extras;

                req.params.extras.split(',').forEach(function (f) {
                    extras[f] = true;
                });

                // Capacity requires most of the data from CNAPI. Unfortunately,
                // this means we need to clean up the largest additions
                // (sysinfo and vms) later on if they weren't also explicitly
                // requested.
                if (extras.capacity && !extras.all) {
                    var noAll = true;
                    options.extras.all = true;
                }
            } else {
                options.extras = {
                    vms: false, memory: false,
                    disk: false, status: true,
                    sysinfo: false, last_heartbeat: false,
                    agents: false
                };
            }

            req.log.debug(options, 'Searching for all servers');
            ModelServer.list(options, function (error, s) {
                if (error) {
                    cb(error);
                    return;
                }

                req.log.debug({ servers: s }, 'Servers found');

                if (!extras || (!extras.all && !extras.sysinfo)) {
                    for (var i in s) {
                        delete s[i].sysinfo;
                    }
                }

                if (!(extras && (extras.capacity || extras.all))) {
                    result = s;
                    cb();
                    return;
                }

                req.log.debug('Running capacity');

                // this mutates s, adding unreserved_cpu, unreserved_ram
                // and unreserved_disk to eligible servers
                Designation.serverCapacity(s,
                function (err, serversUnreserved, reasons) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    req.log.debug({reasons: reasons}, 'Done running capacity');

                    if (noAll) {
                        // if noAll is true, options.extras exists
                        if (!extras.vms) {
                            for (i in s) {
                                delete s[i].vms;
                            }
                        }

                        if (!extras.sysinfo) {
                            for (i in s) {
                                delete s[i].sysinfo;
                            }
                        }
                    }

                    result = s;
                    cb();
                });
            });
        }
    ],
    function (error) {
        if (error) {
            next(new restify.InternalError(error.message));
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
 * @section Server API
 *
 * @example GET /servers/12494d5e-3960-4d65-a61a-0ca6252d6914
 *
 * @response 200 Object The server object
 */
/* END JSSTYLED */

Server.get = function handlerServerGet(req, res, next) {
    var rules = {
        'server_uuid': ['isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    req.stash.server.getFinal({extras:
        {
            sysinfo: true,
            vms: true,
            disk: true,
            agents: true,
            last_heartbeat: true,
            memory: true
        }},
        function (error, server) {
            if (error) {
                next(error);
                return;
            }

            req.log.debug('Running capacity');
            // this mutates server, adding unreserved_cpu, unreserved_ram and
            // unreserved_disk to eligible servers
            Designation.serverCapacity([server], function (err) {
                if (err) {
                    next(err);
                    return;
                }

                req.log.debug('Done running capacity');

                res.send(server);
                next();
            });
        });
};


/* BEGIN JSSTYLED */
/**
 * Set the value of a Server's attribute.
 *
 * @name ServerUpdate
 * @endpoint POST /servers/:server_uuid
 * @section Server API
 *
 * @param {Array} agents Array of agents present on this server
 * @param {String} boot_platform The platform image to be used on next boot
 * @param {String} default_console Console type
 * @param {Number} etag_retries number of times to retry update in case of ETag conflict
 * @param {String} rack_identifier The id of the server's rack
 * @param {String} comments Any comments about the server
 * @param {String} next_reboot ISO timestamp when next reboot is scheduled for
 * @param {Array} nics List of NICs to update (see `Updating NICs` section)
 * @param {Boolean} reserved Server is available for provisioning
 * @param {Boolean} reservoir Server should be considered last for provisioning
 * @param {Number} reservation_ratio The reservation ratio
 * @param {Object} overprovision_ratios The overprovisioning ratios. Must be an object with Number value keys and keys must be one of 'cpu', 'ram', 'disk', 'io', 'net'.
 * @param {String} serial Serial device
 * @param {Boolean} setup True if server has been set up
 * @param {Boolean} setting_up True if server is in the process of setting up
 * @param {String} transitional_status A value to use to override status when the server has status 'unknown'. This is for internal use only and currently is only used by server-reboot to set the state to 'rebooting' while a server is rebooting.
 * @param {Object} traits Server traits
 *
 * @example POST /servers/12494d5e-3960-4d65-a61a
 *          -d '{ "default_console": "vga", "setup", true }'
 *
 * @response 204 None The value was set successfuly
 */
/* END JSSTYLED */

Server.update = function handlerServerUpdate(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.uuid(req.params.server_uuid, 'req.params.server_uuid');

    var rules = {
        'agents': ['optional', 'isArrayType'],
        'boot_params': ['optional', 'isObjectType'],
        'boot_platform': ['optional', 'isStringType', 'isTrim'],
        'comments': ['optional', 'isStringType', 'isTrim'],
        'datacenter': ['optional', 'isStringType', 'isTrim'],
        'default_console': ['optional', 'isStringType', 'isTrim'],
        'etag_retries': ['optional', 'isNumberType'],
        'next_reboot': ['optional', 'isStringType', 'isTrim'],
        'nics': ['optional', 'isArrayType'],
        'overprovision_ratios': ['optional', 'isObjectType'],
        'rack_identifier': ['optional', 'isStringType', 'isTrim'],
        'reservation_ratio': ['optional', 'isNumberType'],
        'reserved': ['optional', 'isBooleanType'],
        'reservoir': ['optional', 'isBooleanType'],
        'serial': ['optional', 'isStringType', 'isTrim'],
        'server_uuid': ['isStringType'],
        'setting_up': ['optional', 'isBooleanType'],
        'setup': ['optional', 'isBooleanType'],
        'traits': ['optional', 'isObjectType'],
        'transitional_status': ['optional', 'isStringType', 'isTrim']
    };
    var serverUuid = req.params.server_uuid;

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    if (req.params.overprovision_ratios) {
        Object.keys(req.params.overprovision_ratios).forEach(function (key) {
            if ([ 'cpu', 'ram', 'disk', 'io', 'net'].indexOf(key) === -1) {
                next(new restify.InvalidArgumentError(
                    'Invalid key %s', key));
            }
            if (typeof (req.params.overprovision_ratios[key]) !== 'number') {
                next(new restify.InvalidArgumentError(
                    'Invalid type for %s', key));
                return;
            }
            if (req.params.overprovision_ratios[key] < 0) {
                next(new restify.InvalidArgumentError(
                    'Invalid value for %s', key));
                return;
            }
        });

        req.params.overprovision_ratios
            = qs.stringify(req.params.overprovision_ratios);
    }

    // Check that if next_reboot is set, it is an ISO date string.
    var nextReboot = req.params.next_reboot;
    if (nextReboot && nextReboot !== new Date(nextReboot).toISOString()) {
        next(new restify.InvalidArgumentError('Invalid date for next_reboot; ' +
             'not an ISO date format'));
        return;
    }

    // Ensure values are cast to the correct types
    var attrs = [
        ['agents', Array],
        ['boot_params', Object],
        ['boot_platform', String],
        ['comments', String],
        ['datacenter', String],
        ['default_console', String],
        ['next_reboot', String],
        ['overprovision_ratios', Object],
        ['rack_identifier', String],
        ['reservation_ratio', Number],
        ['reserved', Boolean],
        ['reservoir', Boolean],
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
                    cb(new VError('failed to find given platform image,'
                        + ' %s', change.boot_platform));
                    return;
                }

                cb();
            });
        },

        // If the server is not setup, we don't need to bother updating the
        // on-server configuration value.
        function (cb) {
            if (!req.params.overprovision_ratios) {
                cb();
                return;
            }

            if (!req.stash.server.value.setup) {
                cb();
                return;
            }

            var request = {
                task: 'server_overprovision_ratio',
                cb: function (err, task) {
                },
                synccb: function (err, result) {
                    cb(err, result);
                },
                req_id: req.getId(),
                params: { value: req.params.overprovision_ratios  }
            };

            req.stash.server.sendTaskRequest(request);
        }
    ],
    function (error) {
        if (error) {
            if (error.code) {
                next(restify.codeToHttpError(error.code, error.message));
                return;
            }

            next(new restify.InternalError(error.message));
            return;
        }

        ModelServer.upsert(serverUuid, change, {
            // We don't currently do any retries here as previous versions
            // didn't either. This means as a client you'll get an ETag error if
            // something changes between the getObject and putObject in the
            // upsert.
            etagRetries: req.params.etag_retries || 0
        }, function (modifyError) {
            if (modifyError) {
                next(new restify.InternalError(modifyError.message));
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
 * @param {String} origin
 * @param {String} creator_uuid
 * @param {Boolean} drain Wait for server's cn-agent to be drained before sending the reboot command
 * @param {Boolean} nojob If true, don't create a workflow job, but instead talk to the server_reboot task in cn-agent (default: false)
 * @section Server API
 *
 * @response 202 Object Server reboot initiated (object with job_uuid is returned)
 * @response 204 None Server reboot initiated
 * @response 500 None Error attempting to set up server
 * @response 503 None When nojob=true, this means the server does not support the server_reboot cn-agent task
 */
/* END JSSTYLED */

Server.reboot = function handlerServerReboot(req, res, next) {
    var self = this;

    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.object(req.stash, 'req.stash');
    assert.object(req.stash.server, 'req.stash.server');

    var cnAgent = getCnAgentFromStashedServer(req.stash.server);
    var params = {
        origin: req.params.origin,
        creator_uuid: req.params.creator_uuid,
        drain: req.params.drain,
        supportsServerRebootTask: false
    };
    var rules = {
        'server_uuid': ['isStringType'],
        'creator_uuid': ['optional', 'isStringType'],
        'drain': ['optional', 'isBooleanType'],
        'nojob': ['optional', 'isBooleanType'],
        'origin': ['optional', 'isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    if (cnAgent.version && semver.gte(cnAgent.version,
        TASK_SERVER_REBOOT_MIN_VERSION)) {

        params.supportsServerRebootTask = true;
    }

    // In nojob=true mode, we'll just call the server_reboot task on the CN.
    // Unless it's unsupported in which case we'll return a ServiceUnavailable
    // since the CN cannot serve this request.
    if (req.params.nojob) {
        vasync.pipeline({arg: {}, funcs: [
            function ensureSupported(ctx, cb) {
                self.log.debug({
                    cnAgent: cnAgent,
                    supported: params.supportsServerRebootTask,
                    serverUuid: req.params.server_uuid,
                    task: 'server_reboot',
                    taskMinVersion: TASK_SERVER_REBOOT_MIN_VERSION
                }, 'cn-agent task detection');

                if (!params.supportsServerRebootTask) {
                    cb(new restify.ServiceUnavailableError('cn-agent version' +
                        ' on server does not support server_reboot: ' +
                        (cnAgent.version ? cnAgent.version : 'unknown') +
                        ' < ' + TASK_SERVER_REBOOT_MIN_VERSION));
                    return;
                }

                cb();
            }, function callServerRebootTask(ctx, cb) {
                req.stash.server.sendTaskRequest({
                    cb: function () {},
                    log: self.log,
                    params: req.params,
                    req_id: req.getId(),
                    synccb: function (err, results) {
                        if (err) {
                            self.log.error({
                                err: err
                            }, 'error returned from server_reboot');
                        }

                        cb(err);
                    },
                    task: 'server_reboot'
                });
           }
        ]}, function _doneReboot(err) {
            if (!err) {
                res.send(204);
            }
            next(err);
        });
        return;
    }

    req.stash.server.reboot(params, function (rebootError, jobUuid) {
        if (rebootError) {
            next(new restify.InternalError(rebootError.message));
            return;
        }
        res.send(202, { job_uuid: jobUuid });
        next();
        return;
    });
};

/* BEGIN JSSTYLED */
/**
 * Reset the server back to a factory state.
 *
 * @name ServerFactoryReset
 * @endpoint PUT /servers/:server\_uuid/factory-reset
 * @section Server API
 *
 * @response 204 Object Setup initated, returns object containing workflow id
 * @response 500 None Error attempting to set up server
 */
/* END JSSTYLED */

Server.factoryReset = function handlerServerFactoryReset(req, res, next) {
    var server = req.stash.server.getValue();
    var vms = server.vms;

    var rules = {
        'server_uuid': ['isStringType'],
        'creator_uuid': ['optional', 'isStringType'],
        'origin': ['optional', 'isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
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

    req.stash.server.factoryReset({
        origin: req.params.origin,
        creator_uuid: req.params.creator_uuid
    },
    function (resetError, jobUuid) {
        if (resetError) {
            next(new restify.InternalError(resetError.message));
            return;
        }

        res.send(202, { job_uuid: jobUuid });
        next();
    });
};


/* BEGIN JSSTYLED */
/**
 * Initiate the server setup process for a newly started server.
 *
 * @name ServerSetup
 * @endpoint PUT /servers/:server_uuid/setup
 * @section Server API
 * @param {Object} nics Nic parameters to update
 * @param {String} postsetup_script Script to run after setup has completed
 * @param {String} hostname Hostname to set for the specified server
 * @param {String} disk_spares See `man disklayout` spares
 * @param {String} disk_width See `man disklayout` width
 * @param {String} disk_cache See `man disklayout` cache
 * @param {String} disk_layout See `man disklayout` type
 *      (single, mirror, raidz1, ...)
 * @param {String} encryption_enabled Encrypt or not the server zpool. (Boolean
 *      String type) See `man mkzpool -e` option
 * @response 200 Object Setup initated, returns object containing workflow id
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

Server.setup = function handlerServerSetup(req, res, next) {
    var rules = {
        'hostname': ['optional', 'isStringType'],
        'nics': ['optional', 'isArrayType'],
        'postsetup_script': ['optional', 'isStringType'],
        'server_uuid': ['isStringType'],
        'disk_spares': ['optional', 'isNumberGreaterThanEqualZeroType'],
        'disk_width': ['optional', 'isNumberGreaterThanEqualZeroType'],
        'disk_cache': ['optional', 'isBooleanString'],
        'disk_layout': ['optional', 'isStringType'],
        'encryption_enabled': ['optional', 'isBooleanString']
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
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
    if (req.params.hasOwnProperty('origin')) {
        params.origin = req.params.origin;
    }
    if (req.params.hasOwnProperty('creator_uuid')) {
        params.creator_uuid = req.params.creator_uuid;
    }
    if (typeof (req.params.disk_spares) !== 'undefined') {
        params.disk_spares = req.params.disk_spares;
    }
    if (typeof (req.params.disk_width) !== 'undefined') {
        params.disk_width = req.params.disk_width;
    }
    if (typeof (req.params.disk_cache) !== 'undefined') {
        params.disk_cache = (req.params.disk_cache === 'true');
    }
    if (typeof (req.params.encryption_enabled) !== 'undefined') {
        params.encryption_enabled = (req.params.encryption_enabled === 'true');
    }
    if (typeof (req.params.disk_layout) !== 'undefined') {
        var layout = req.params.disk_layout;
        var VALID_LAYOUTS = ['single', 'mirror', 'raidz1', 'raidz2', 'raidz3'];
        if (VALID_LAYOUTS.indexOf(layout) === -1) {
            var err = new restify.InvalidArgumentError(
                sprintf('disk_layout must be one of: \'%s\'',
                    VALID_LAYOUTS.join('\', \'')));
            res.send(err);
            next();
            return;
        }
        params.disk_layout = layout;
    }

    if (req.stash.server.value.setup) {
        // Already setup
        res.send(204);
        next();
        return;
    }

    req.stash.server.setup(params, function (setupError, jobUuid) {
        if (setupError) {
            next(new restify.InternalError(setupError.message));
            return;
        }
        res.send(202, { job_uuid: jobUuid });
        next();
        return;
    });
};


/* BEGIN JSSTYLED */
/**
 * Register a given server's sysinfo values and store them in the server object.
 * Does the same thing as CNAPI receiving a sysinfo message via Ur. This means
 * that if you post sysinfo for a non-existent server, a server record will be
 * created.
 *
 * IMPORTANT: This endpoint is only intended to be used by cn-agent. Any other
 * use will not be supported and may break in the future.
 *
 * @name ServerSysinfoRegister
 * @endpoint POST /servers/:server_uuid/sysinfo
 * @section Server API
 * @param {Object} sysinfo Sysinfo Object.
 *
 * @response 200 None Sysinfo registration initiated
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

Server.sysinfoRegister = function handlerServerSysinfoRegister(req, res, next) {
    var newSysinfo;
    var rules = {
        'server_uuid': ['isStringType'],
        'sysinfo': ['isObjectType']
    };
    var server_uuid;

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    newSysinfo = req.params.sysinfo;
    server_uuid = req.params.server_uuid;

    assert.equal(server_uuid, newSysinfo['UUID'],
        'Got sysinfo for wrong server');

    req.log.info({
        server_uuid: server_uuid,
        sysinfo: newSysinfo
    }, 'Registering sysinfo for server');

    ModelServer.updateFromSysinfo(newSysinfo, function onSysinfoUpdated(err) {
        if (err) {
            req.log.error({
                err: err,
                server_uuid: server_uuid,
                sysinfo: newSysinfo
            }, 'failed to register updated sysinfo');
        } else {
            req.log.info({
                server_uuid: server_uuid
            }, 'successfully registered updated sysinfo');
            res.send(200);
        }
        next(err);
    });
};

/* BEGIN JSSTYLED */
/**
 * *IMPORTANT: This endpoint is deprecated and will be removed in a future
 * release. It exists only for backward compatibility and should not be used for
 * any new development. As of version 2.9.0, cn-agent will keep the sysinfo
 * up-to-date, so there's no need to call this.*
 *
 * Fetch a given server's sysinfo values and store them in the server object.
 *
 * @name ServerSysinfoRefresh (deprecated)
 * @endpoint POST /servers/:server_uuid/sysinfo-refresh
 * @section Server API
 *
 * @response 200 Object Sysinfo refresh initiated
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

Server.sysinfoRefresh = function handlerServerSysinfoRefresh(req, res, next) {
    var self = this;

    var rules = {
        'server_uuid': ['isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    vasync.pipeline({arg: {}, funcs: [
        function detectSysinfoTask(ctx, cb) {
            var cnAgent = getCnAgentFromStashedServer(req.stash.server);

            if (cnAgent.version && semver.gte(cnAgent.version,
                TASK_SERVER_SYSINFO_MIN_VERSION)) {

                ctx.haveSysinfoTask = true;
            } else {
                ctx.haveSysinfoTask = false;
            }

            self.log.trace({
                cnAgent: cnAgent,
                haveSysinfoTask: ctx.haveSysinfoTask,
                serverUuid: req.params.server_uuid
            }, 'cn-agent detection');

            cb();
        }, function callSysinfoTaskIfExists(ctx, cb) {
            if (!ctx.haveSysinfoTask) {
                cb();
                return;
            }

            req.stash.server.sendTaskRequest({
                cb: function () {},
                log: self.log,
                params: req.params,
                req_id: req.getId(),
                synccb: function (error, results) {
                    if (error) {
                        cb(error);
                        return;
                    }

                    ctx.sysinfo = results.sysinfo;
                    self.log.trace({
                        sysinfo: ctx.sysinfo
                    }, 'Got sysinfo from server_sysinfo task');

                    cb();
                },
                task: 'server_sysinfo'
            });
        }, function fallbackToExec(ctx, cb) {
            var params = {
                script: '#!/bin/bash\n/usr/bin/sysinfo\n'
            };

            if (ctx.sysinfo !== undefined) {
                // already got sysinfo, no need to exec
                cb();
                return;
            }

            Server.executeCommand({
                log: self.log,
                params: params,
                req_id: req.getId(),
                server: req.stash.server
            }, function _onExecuted(err, results) {
                if (err) {
                    cb(err);
                    return;
                }

                if (results.exitCode === 0) {
                    ctx.sysinfo = JSON.parse(results.stdout.trim());
                    self.log.trace({
                        sysinfo: ctx.sysinfo
                    }, 'Got sysinfo from CommandExecute');
                } else {
                    self.log.error({
                        results: results
                    }, 'Failed to get sysinfo from CommandExecute');
                }

                cb();
            });
        }, function updateFromSysinfo(ctx, cb) {
            if (!ctx.sysinfo) {
                cb(new Error('Unable to gather latest sysinfo'));
                return;
            }

            ModelServer.updateFromSysinfo(ctx.sysinfo,
                function onSysinfoUpdated(err) {
                    if (err) {
                        self.log.error({
                            err: err,
                            server_uuid: ctx.sysinfo.UUID,
                            sysinfo: ctx.sysinfo
                        }, 'Failed to apply sysinfo');
                    } else {
                        req.log.info({
                            server_uuid: ctx.sysinfo.UUID
                        }, 'Successfully refreshed sysinfo');
                    }

                    cb(err);
                });
        }
    ]}, function _updatedSysinfo(err) {
        if (err) {
            next(err);
            return;
        }

        res.send(200);
        next();
    });
};

/* BEGIN JSSTYLED */
/**
 * Remove all references to given server. Does not change anything on the
 * actual server.
 *
 * @name ServerDelete
 * @endpoint DELETE /servers/:server_uuid
 * @section Server API
 *
 * @response 204 None Server was deleted successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Server.del = function handlerServerDelete(req, res, next) {
    var rules = {
        'server_uuid': ['isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

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


/* BEGIN JSSTYLED */
/**
 * Return details of most recent cn-agent tasks run on the compute node since
 * cn-agent was started.
 *
 * @name ServerTaskHistory
 * @endpoint GET /servers/:server_uuid/task-history
 * @section Server API
 *
 * @response 200 Ok Tasks returned successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Server.taskHistory = function handlerServerTaskHistory(req, res, next) {
    var server = req.stash.server;

    var rules = {
        'server_uuid': ['isStringType']
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    server.sendRequest({
        method: 'get',
        path: '/history'
    }, function (err, history) {
        if (err) {
            next(new restify.InternalError(err));
            return;
        }
        res.send(200, history);
        next();
    });
};

/* BEGIN JSSTYLED */
/**
 * Makes cn-agent stop accepting new tasks
 *
 * @name ServerPauseCnAgent
 * @endpoint GET /servers/:server_uuid/cn-agent/pause
 * @section Server API
 *
 * @response 204 No Content on success
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */
Server.pauseCnAgent = function handlerServerPauseCnAgent(req, res, next) {
    var server = req.stash.server;
    server.sendRequest({
        method: 'post',
        path: '/pause'
    }, function (err) {
        if (err) {
            next(new restify.InternalError(err));
            return;
        }
        res.send(204);
        next();
    });
};

/* BEGIN JSSTYLED */
/**
 * Makes cn-agent accept new tasks
 *
 * Note this is the default behavior and this end-point is useful
 * only after a previous call to ServerPauseCnAgent
 *
 * @name ServerResumeCnAgent
 * @endpoint GET /servers/:server_uuid/cn-agent/resume
 * @section Server API
 *
 * @response 204 No Content on success
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */
Server.resumeCnAgent = function handlerResumeCnAgent(req, res, next) {
    var server = req.stash.server;
    server.sendRequest({
        method: 'post',
        path: '/resume'
    }, function (err) {
        if (err) {
            next(new restify.InternalError(err));
            return;
        }
        res.send(204);
        next();
    });
};

/*
 * This endpoint has only one job. That's to update the value of:
 *
 *     app.observedHeartbeats[serverUuid].last_heartbeat
 *
 * to the current timestamp, indicating that we just got a heartbeat for this
 * server. The actual processing of these heartbeats happens elsewhere via a
 * periodic timer. (See: lib/heartbeat_reconciler.js)
 */
Server.eventHeartbeat = function handlerServerEventHeartbeat(req, res, next) {
    var app = req.stash.app;
    var rules = {
        'server_uuid': ['isStringType']
    };
    var serverUuid;

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    serverUuid = req.params.server_uuid;

    if (!app.observedHeartbeats) {
        app.observedHeartbeats = {};
    }

    if (!app.observedHeartbeats[serverUuid]) {
        app.observedHeartbeats[serverUuid] = {
            server_uuid: serverUuid
        };
    }

    app.observedHeartbeats[serverUuid].last_heartbeat =
        (new Date()).toISOString();

    res.send(204);
    next();
};

Server.eventStatusUpdate =
function handlerServerEventStatusUpdate(req, res, next) {
    ModelServer.getApp().onStatusUpdate({
        params: req.params,
        serverModel: req.stash.server
    }, function (err) {
        if (err) {
            req.log.error({ error: err }, 'Failed to update status');
            return;
        }
    });

    // We're intentionally updating asynchronously here.
    res.send(204);
    next();
};

/* BEGIN JSSTYLED */
/**
 * Assert an image is present on a compute node and ready for use in
 * provisioning. If this is not the case, fetch and install the image onto the
 * compute node zpool.
 *
 * @name ServerEnsureImage
 * @endpoint GET /servers/:server_uuid/ensure-image
 * @section Server API
 * @param {String} image_uuid UUID of image to install
 * @param {String} zfs_storage_pool_name zpool on which to install image
 *
 * @response 204 None Tasks returned successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Server.ensureImage = function handlerServerEnsureImage(req, res, next) {
    var rules = {
        'server_uuid': ['isStringType'],
        'image_uuid': ['isStringType'],
        'zfs_storage_pool_name':  ['optional', 'isStringType'],
        'imgapiPeers':  ['optional', 'isArrayType']
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    req.stash.server.sendTaskRequest({
        log: req.log,
        task: 'image_ensure_present',
        params: req.params,
        req_id: req.getId(),
        cb: function (error, task) {
            res.send({ id: task.id });
            next();
            return;
        }
    });
};


Server.executeCommand = function executeCommand(opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.params, 'opts.params');
    assert.optionalArray(opts.params.args, 'opts.params.args');
    assert.optionalObject(opts.params.env, 'opts.params.env');
    assert.optionalBool(opts.params.json, 'opts.params.json');
    assert.string(opts.params.script, 'opts.params.script');
    assert.optionalNumber(opts.params.timeout, 'opts.params.timeout');
    assert.optionalFunc(opts.evcb, 'opts.evcb');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.server, 'opts.server');
    assert.func(callback, 'callback');

    var handleWithUr = true; // default to Ur for backward compat
    var useCnAgentCommandExecute =
        Boolean(ModelServer.getConfig().useCnAgentCommandExecute);

    opts.log.info({
        params: opts.params,
        useCnAgentCommandExecute: useCnAgentCommandExecute
    }, 'Executing command');

    vasync.pipeline({arg: {}, funcs: [
        function getCnAgentVersion(ctx, cb) {
            ctx.cnAgent = getCnAgentFromStashedServer(opts.server);
            opts.log.trace({cnAgent: ctx.cnAgent}, 'got cn-agent info');
            cb();
        }, function callUrIfAncient(ctx, cb) {
            if (useCnAgentCommandExecute &&
                ctx.cnAgent.version &&
                semver.gte(ctx.cnAgent.version,
                    TASK_COMMAND_EXECUTE_MIN_VERSON)) {

                handleWithUr = false;
            }

            opts.log.trace({
                cnAgent: ctx.cnAgent,
                handleWithUr: handleWithUr
            }, 'CommandExecute checked for cn-agent');

            cb();
            return;
        }
    ]}, function sendRequest(err) {
        var msg;
        var params = {
            args: opts.params.args,
            env: opts.params.env,
            timeout: opts.params.timeout
        };

        if (err) {
            callback(err);
            return;
        }

        if (handleWithUr) {
            // Ur's execute functionality
            if (opts.params.hasOwnProperty('timeout') &&
                opts.params.timeout !== undefined) {

                msg = 'timeout only supported when using cn-agent (See: ' +
                    'FEATURE_USE_CNAGENT_COMMAND_EXECUTE)';
                self.log.error(msg);
                callback(new restify.InvalidArgumentError(msg));
                return;
            }

            opts.server.invokeUrScript(opts.params.script, params,
                function _onUrResult(urErr, stdout, stderr, exitStatus) {

                if (urErr) {
                    callback(urErr);
                    return;
                }

                callback(null, {
                    exitCode: exitStatus,
                    stderr: stderr,
                    stdout: stdout
                });
            });
        } else {
            params.script = opts.params.script;

            // cn-agent's command_execute task
            opts.server.sendTaskRequest({
                cb: function () {},
                log: opts.log,
                params: params,
                req_id: opts.req_id,
                synccb: function (error, results) {
                    if (error) {
                        callback(error);
                        return;
                    }

                    callback(null, results);
                },
                task: 'command_execute'
            });
        }
    });
};



/* BEGIN JSSTYLED */
/**
 * *IMPORTANT: This endpoint is deprecated and will be removed in a future
 * release. It exists only for backward compatibility and should not be used for
 * any new development. If you wish to execute commands on a CN, this should be
 * done through a new cn-agent task, or a new agent.*
 *
 * Synchronously execute a command on the target server.
 *
 * If `json` is true, the result returned will be a JSON object with `stdout`,
 * `stderr` and `exitCode` properties. If the json flag is not passed or not set
 * true, the body of the response will contain only the stdout and if the script
 * executed non-zero a 500 error will be returned.
 *
 * @name CommandExecute (deprecated)
 * @endpoint POST /servers/:server_uuid/execute
 * @section Remote Execution API (deprecated)
 *
 * @param {Array} args Array containing arguments to be passed in to command
 * @param {Object} env Object containing environment variables to be passed in
 * @param {String} script Script to be executed. Must have a shebang line
 * @param {Boolean} json Whether to return results as JSON instead of just stdout (default = false)
 * @param {Integer} timeout Number of ms to wait for command completion before killing task and returning (only supported when using cn-agent, See: FEATURE_USE_CNAGENT_COMMAND_EXECUTE)
 *
 * @response 404 None No such server
 * @response 500 None Error occurred executing script
 *
 */
/* END JSSTYLED */
Server.execute = function handlerCommandExecute(req, res, next) {
    var self = this;

    var rules = {
        'args': ['optional', 'isArrayType'],
        'env': ['optional', 'isObjectType'],
        'json': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ],
        'script': ['isStringType'],
        'timeout': ['optional', 'isNumberType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    Server.executeCommand({
        log: self.log,
        params: req.params,
        req_id: req.getId(),
        server: req.stash.server
    }, function _onExecuted(err, results) {
        if (err) {
            next(err);
            return;
        }

        if (req.params.json) {
            res.send(results);
        } else {
            // For backward compat we want to return an error if
            // script exited non-zero.
            if (results.exitCode !== 0) {
                next(new restify.InternalError(
                    'Error executing on remote system'));
                    return;
            }
            // backward compatibly lose stderr
            res.send(results.stdout.trim());
        }
        next();
        return;
    });
};


/* BEGIN JSSTYLED */
/**
 * Instruct server to install given agent. Pass in image uuid of package to
 * install and server will download and install package.
 *
 * @name ServerInstallAgent
 * @endpoint POST /servers/:server_uuid/install-agent
 * @section Server API
 * @param {String} image_uuid UUID of image to install
 * @param {String} package_name Package name
 * @param {String} package_file Package file
 *
 * @response 200 Ok Install task initiated successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Server.installAgent = function handlerServerInstallAgent(req, res, next) {
    req.stash.server.sendTaskRequest({
        log: req.log,
        task: 'agent_install',
        params: req.params,
        req_id: req.getId(),
        cb: function (error, task) {
            res.send({ id: task.id });
            next();
            return;
        }});
};


/**
 * Uninstall the given agents on the server.
 * (Requires cn-agent v2.8.0 or later.)
 *
 * @name ServerUninstallAgents
 * @endpoint POST /servers/:server_uuid/uninstall-agents
 * @section Server API
 * @param {Array} agents The names of the agents to uninstall. Passing
 *      "cn-agent" as an agent to remove results in undefined (and likely
 *      destructive) behaviour.
 *
 * @response 200 Ok Uninstall task created successfully
 * @response 412 Error PreconditionFailed if the target server has a cn-agent
 *      that is too old.
 * @response 500 Error Could not process request
 */
Server.uninstallAgents = function uninstallAgents(req, res, next) {
    var self = this;
    const CN_AGENT_VERSION_WITH_AGENTS_UNINSTALL = '2.8.0';

    // Dev Note: The `execute` task above provides a fallback to using Ur if
    // the target server's cn-agent is older and doesn't have the relevant task.
    // There isn't a backward compatibility requirement here, so this task
    // does not provide that default. It is up to the caller to know that
    // a cn-agent of at least version 2.8.0 is required.

    var rules = {
        'agents': ['isArrayType']
    };
    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    vasync.pipeline({arg: {}, funcs: [
        function getCnAgentVersion(ctx, cb) {
            req.stash.server.getFinal({extras: {
                sysinfo: false,
                vms: false,
                disk: false,
                agents: true,
                last_heartbeat: false,
                memory: false
            }}, function (err, server) {
                var agent;
                var idx;

                if (err) {
                    cb(new VError(err, 'could not determine cn-agent version'));
                    return;
                }

                ctx.cnAgent = {}; // To ensure we always have an object.
                for (idx = 0; idx < server.agents.length; idx++) {
                    agent = server.agents[idx];
                    if (agent.name === 'cn-agent') {
                        ctx.cnAgent = agent;
                        break;
                    }
                }

                cb();
            });
        },
        function bailIfCnAgentTooOld(ctx, cb) {
            if (!ctx.cnAgent.version ||
                semver.lt(ctx.cnAgent.version,
                    CN_AGENT_VERSION_WITH_AGENTS_UNINSTALL))
            {
                cb(new errors.PreconditionFailedError(
                    'cn-agent (v%s) on server %s does not support '
                    + '"agents_uninstall": require at least cn-agent v%s',
                    ctx.cnAgent.version, req.stash.server.uuid,
                    CN_AGENT_VERSION_WITH_AGENTS_UNINSTALL));
            } else {
                self.log.debug(
                    'server %s cn-agent supports "agents_uninstall": v%s',
                    req.stash.server.uuid, ctx.cnAgent.version);
                cb();
            }
        },
        function requestCnAgentTask(ctx, cb) {
            req.stash.server.sendTaskRequest({
                log: req.log,
                task: 'agents_uninstall',
                params: req.params,
                req_id: req.getId(),
                cb: function onTaskRequested(_taskReqErr, task) {
                    res.send({ id: task.id });
                    cb();
                }
            });
        }
    ]}, function finish(err) {
        next(err);
    });
};


Server.nop = function handlerServerNop(req, res, next) {
    req.params.sleep = parseInt(req.params.sleep, 10) || 0;
    req.stash.server.sendTaskRequest({
        task: 'nop',
        params: req.params,
        req_id: req.getId(),
        cb: function (error, taskstatus) {
            res.send({ id: taskstatus.id });
            next();
        }
    });
};


/* BEGIN JSSTYLED */
/**
 * Stage/Activate the given Recovery Configuration on the server,
 * only if the server is using EDAR (Zpool Encrypted: true).
 * (Requires cn-agent v2.13.0 or later)
 *
 * @name ServerRecoveryConfig
 * @endpoint POST /servers/:server_uuid/recovery-config
 * @section Server API
 * @param {String} recovery_uuid UUID of the recovery configuration to
 *      stage or activate.
 * @param {String} action name of the action to execute: "stage" or
 *      "activate". Cannot "activate" a recovery configuration not already
 *      reported by the Server's sysinfo as staged through the `Zpool Recovery`
 *      sysinfo property.
 * @param {String} template pivy-box recovery configuration template to
 *      be staged into the CN.
 * @param {String} token the recovery token to stage with the recovery
 *      configuration.
 * @param {String} pivtoken GUID of the PIVToken the recovery token is
 *      associated with.
 *
 * @response 200 Ok Install task initiated successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Server.recoveryConfig = function handlerServerRecoveryConfig(req, res, next) {
    var self = this;

    const CN_AGENT_VERSION_WITH_RECOVERY_CONFIG = '2.13.0';

    function repeatableUUIDFromHexString(hexStr) {
        var buf = Buffer.from(hexStr, 'hex');
        // variant:
        buf[8] = buf[8] & 0x3f | 0xa0;
        // version:
        buf[6] = buf[6] & 0x0f | 0x50;
        var hex = buf.toString('hex', 0, 16);
        const uuid = [
            hex.substring(0, 8),
            hex.substring(8, 12),
            hex.substring(12, 16),
            hex.substring(16, 20),
            hex.substring(20, 32)
        ].join('-');
        return uuid;
    }

    vasync.pipeline({arg: {}, funcs: [
        function validateParams(ctx, cb) {
            const action = req.params.action;
            if (!action || !req.params.recovery_uuid || !req.params.pivtoken) {
                cb(new errors.PreconditionFailedError(
                    '"recovery_uuid", "pivtoken" and "action" ' +
                    'params must be provided'));
                return;
            }

            if (['stage', 'activate'].indexOf(action) === -1) {
                cb(new errors.PreconditionFailedError(
                    'Invalid "action" param. It must be one of "stage" or ' +
                    '"activate"'));
                return;
            }

            if (action === 'stage' &&
                (!req.params.template || !req.params.token)) {
                cb(new errors.PreconditionFailedError(
                    '"template" and "token" params must be provided for ' +
                    'recovery configuration "stage"'));
                return;
            }

            ctx.params = {
                action: action,
                recovery_uuid: req.params.recovery_uuid,
                pivtoken: req.params.pivtoken
            };

            if (req.params.template) {
                ctx.params.template = req.params.template;
            }

            if (req.params.token) {
                ctx.params.token = req.params.token;
            }

            cb();
        },
        function getCnAgentVersion(ctx, cb) {
            req.stash.server.getFinal({extras: {
                sysinfo: true,
                vms: false,
                disk: false,
                agents: true,
                last_heartbeat: false,
                memory: false
            }}, function (err, server) {
                var agent;
                var idx;

                if (err) {
                    cb(new VError(err, 'could not determine cn-agent version'));
                    return;
                }
                ctx.zpoolEncrypted = server.sysinfo['Zpool Encrypted'] || false;
                ctx.zpoolRecovery = server.sysinfo['Zpool Recovery'] || {};
                ctx.cnAgent = {}; // To ensure we always have an object.
                for (idx = 0; idx < server.agents.length; idx++) {
                    agent = server.agents[idx];
                    if (agent.name === 'cn-agent') {
                        ctx.cnAgent = agent;
                        break;
                    }
                }

                cb();
            });
        },
        function bailIfCnAgentTooOld(ctx, cb) {
            if (!ctx.cnAgent.version ||
                semver.lt(ctx.cnAgent.version,
                    CN_AGENT_VERSION_WITH_RECOVERY_CONFIG)) {
                cb(new errors.PreconditionFailedError(
                    'cn-agent (v%s) on server %s does not support '
                    + '"recovery_config": require at least cn-agent v%s',
                    ctx.cnAgent.version, req.stash.server.uuid,
                    CN_AGENT_VERSION_WITH_RECOVERY_CONFIG));
                return;
            }
            self.log.debug(
                'server %s cn-agent supports "agents_uninstall": v%s',
                req.stash.server.uuid, ctx.cnAgent.version);
            cb();
        },
        function bailIfNotGivenRecoveryRequirements(ctx, cb) {
            if (!ctx.zpoolEncrypted) {
                cb(new errors.PreconditionFailedError(
                    'Recovery Configuration can be set only for servers ' +
                    'with encrypted zpools'));
                return;
            }

            const zRec = ctx.zpoolRecovery;
            // We don't need the whole HEX string, just the UUID generated
            // using it:
            if (zRec.active) {
                zRec.active = repeatableUUIDFromHexString(zRec.active);
            }

            if (zRec.staged) {
                zRec.staged = repeatableUUIDFromHexString(zRec.staged);
            }

            if (zRec.active && zRec.active === ctx.params.recovery_uuid &&
                ctx.params.action === 'activate') {
                cb(new errors.PreconditionFailedError(
                    'Recovery configuration %s is already active',
                    ctx.params.recovery_uuid));
                return;
            }


            if (ctx.params.action === 'activate' && (!zRec.staged ||
                zRec.staged !== ctx.params.recovery_uuid)) {
                cb(new errors.PreconditionFailedError(
                    'Only the staged Recovery configuration ' +
                    'can be activated'));
                return;
            }

            cb();
        },
        function requestCnAgentTask(ctx, cb) {
            req.stash.server.sendTaskRequest({
                log: req.log,
                task: 'recovery_config',
                params: ctx.params,
                req_id: req.getId(),
                cb: function onTaskRequested(_taskReqErr, task) {
                    res.send({ id: task.id });
                    cb();
                }
            });
        }
    ]}, next);
};


function attachTo(http, app) {
    var ensure = require('../endpoints').ensure;

    // List servers
    http.get(
        { path: '/servers', name: 'ServerList' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray']
        }),
        Server.list);

    // Get server
    http.get(
        { path: '/servers/:server_uuid', name: 'ServerGet' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.get);

    // Update server
    http.post(
        { path: '/servers/:server_uuid', name: 'ServerUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray', 'workflow']
        }),
        Server.update);

    // Invoke script on server
    http.post(
        { path: '/servers/:server_uuid/execute', name: 'CommandExecute' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.execute);

    // Setup server
    http.put(
        { path: '/servers/:server_uuid/setup', name: 'ServerSetup' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray', 'workflow']
        }),
        Server.setup);

    // Reboot server
    http.post(
        { path: '/servers/:server_uuid/reboot', name: 'ServerReboot' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray', 'workflow']
        }),
        Server.reboot);

    // Delete server
    http.del(
        { path: '/servers/:server_uuid', name: 'ServerDelete' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray', 'workflow']
        }),
        Server.del);

    // Import an image to the server
    http.post({
        path: '/servers/:server_uuid/ensure-image',
        name: 'ServerEnsureImage' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.ensureImage);

    // Install a Triton agent on the server
    http.post({
        path: '/servers/:server_uuid/install-agent',
        name: 'ServerInstallAgent' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.installAgent);

    // Uninstall one or more Triton agents on the server
    http.post({
        path: '/servers/:server_uuid/uninstall-agents',
        name: 'ServerUninstallAgents' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.uninstallAgents);

    // Refresh server sysinfo
    http.post({
        path: '/servers/:server_uuid/sysinfo-refresh',
        name: 'ServerSysinfoRefresh' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray', 'workflow']
        }),
        Server.sysinfoRefresh);

    // Register server sysinfo
    http.post({
        path: '/servers/:server_uuid/sysinfo',
        name: 'ServerSysinfoRegister' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: [],
            connected: ['moray', 'workflow']
        }),
        Server.sysinfoRegister);

    // Factory-reset server
    http.put({
        path: '/servers/:server_uuid/factory-reset',
        name: 'ServerFactoryReset' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray', 'workflow']
        }),
        Server.factoryReset);

    // Update recovery configuration on the server
    http.post({
        path: '/servers/:server_uuid/recovery-config',
        name: 'ServerRecoveryConfig' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.recoveryConfig);

    // cn-agent task history
    http.get({
        path: '/servers/:server_uuid/task-history',
        name: 'ServerTaskHistory' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.taskHistory);

    // cn-agent pause-resume
    http.post({
        path: '/servers/:server_uuid/cn-agent/pause',
        name: 'ServerPauseCnAgent' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.pauseCnAgent);

    http.post({
        path: '/servers/:server_uuid/cn-agent/resume',
        name: 'ServerResumeCnAgent' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.resumeCnAgent);

    http.post({
        path: '/servers/:server_uuid/events/heartbeat',
        name: 'ServerEventHeartbeat' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: [],
            connected: []
        }),
        Server.eventHeartbeat);

    http.post({
        path: '/servers/:server_uuid/events/status',
        name: 'ServerEventStatusUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: []
        }),
        Server.eventStatusUpdate);

    /**
     *
     * Misc
     *
     */

    // No-op task
    http.post(
        { path: '/servers/:server_uuid/nop', name: 'DoNop' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        Server.nop);
}


exports.attachTo = attachTo;
