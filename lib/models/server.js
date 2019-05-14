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
 * This file contains all the Compute Server logic, used to interface with the
 * server as well as it's stored representation in the backend datastores.
 */

var async = require('async');
var assert = require('assert-plus');
var deepDiff = require('deep-object-diff').diff;
var dns = require('dns');
var jsprim = require('jsprim');
var netconfig = require('triton-netconfig');
var qs = require('qs');
var restify = require('restify');
var sdcClients = require('sdc-clients');
var sprintf = require('sprintf').sprintf;
var vasync = require('vasync');
var VError = require('verror');
var once = require('once');

var buckets = require('../apis/moray').BUCKETS;
var common = require('../common');
var ModelBase = require('./base');
var ModelVM = require('./vm');
var ModelWaitlist = require('./waitlist');

// These are all updated through "status" messages from cn-agent
var DISK_USAGE_KEYS = [
    'disk_cores_quota_bytes',
    'disk_cores_quota_used_bytes',
    'disk_installed_images_used_bytes',
    'disk_kvm_quota_bytes',
    'disk_kvm_quota_used_bytes',
    'disk_kvm_zvol_used_bytes',
    'disk_kvm_zvol_volsize_bytes',
    'disk_pool_alloc_bytes',
    'disk_pool_size_bytes',
    'disk_system_used_bytes',
    'disk_zone_quota_bytes',
    'disk_zone_quota_used_bytes'
];

// These are all updated through "status" messages from cn-agent
var MEMORY_USAGE_KEYS = [
    'memory_arc_bytes',
    'memory_available_bytes',
    'memory_provisionable_bytes',
    'memory_total_bytes'
];

/* BEGIN JSSTYLED */
var GENERAL_KEYS = [
    'agents',                  // updated by cn-agent (ServerUpdate)
    'boot_modules',            // bootparams
    'boot_params',             // bootparams + ServerUpdate
    'boot_platform',           // bootparams + ServerUpdate
    'comments',                // added manually (ServerUpdate)
    'created',                 // set when we first see a server, from zpool info or current timestamp
    'current_platform',        // sysinfo['Live Image']
    'datacenter',              // set from CNAPI config when creating server, can be modified with ServerUpdate
    'default_console',         // bootparams + ServerUpdate
    'headnode',                // set from sysinfo['Boot Parameters']['headnode']
    'hostname',                // set from sysinfo on first creation
    'kernel_flags',            // bootparams
    'last_boot',               // sysinfo['Boot Time']
    'next_reboot',             // updated manually (ServerUpdate)
    'overprovision_ratios',    // ServerUpdate (See also TRITON-441)
    'rack_identifier',         // starts as empty string, updated with ServerUpdate
    'ram',                     // sysinfo['MiB of Memory']
    'reservation_ratio',       // default value at creation, then updated with ServerUpdate
    'reserved',                // defaults to false, then updated with ServerUpdate
    'reservoir',               // defaults to false, then updated with ServerUpdate
    'serial',                  // bootparams + ServerUpdate
    'setting_up',              // ServerUpdate (set true during server setup)
    'setup',                   // sysinfo['Setup']
    'status',                  // special, see below
    'sysinfo',                 // the whole sysinfo object from /usr/bin/sysinfo
    'traits',                  // initially empty, updated manually (POST /servers/:uuid
    'transitional_status',     // initially undefined, updated via ServerUpdate when needed (currently only for server-reboot)
    'uuid',                    // sysinfo['UUID'] (from SMBIOS)
    'vms'                      // updated via status messages from cn-agent
];
/* END JSSTYLED */

//
// The special "status" field is currently updated differently depending on
// whether a server is setup or not. For unsetup servers, we mark status as
// 'running' if we have seen an ur.sysinfo broadcast message in the last 90
// seconds. For setup servers, the status is marked running if we have seen
// heartbeat from cn-agent in the last 11 seconds. Otherwise, the server is
// marked 'unknown'. When a CN is rebooting we also set transitional_status
// to 'rebooting' (in the server-reboot job) and replace 'unknown' with
// 'rebooting' as the status when that is set. So consumers should only look at
// status for the values: ['running', 'unknown', 'rebooting'].
//
// The "bootparams" fields are initially set to the default bootparams and
// maintained after that through the bootparams endpoints. Most of these can
// also (confusingly) be set through ServerUpdate.
//

// Only keys in this list will be included in server objects we write to moray.
var SERVER_KEYS = [].concat(
    DISK_USAGE_KEYS,
    GENERAL_KEYS,
    MEMORY_USAGE_KEYS
).sort();

//
// NOTE:
//
// There are more fields that will show up in objects, but are not written to
// Moray. These are:
//
//  last_hearbeat (deprecated, added based on heartbeats this CNAPI has seen)
//
// and the following which are all added by Designation when doing a GET/LIST:
//
//  score
//  unreserved_cpu
//  unreserved_disk
//  unreserved_ram
//

var NON_UPDATABLE_KEYS = [
    'created',
    'hostname',
    'uuid'
];

/**
 * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 *
 * ModelServer encapsulates the logic for manipulating and interacting
 * servers and their back-end storage representation.
 *
 * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */

function ModelServer(uuid) {
    if (!uuid) {
        throw new Error('ModelServer missing uuid parameter');
    }

    this.value = null;

    // This can be a server UUID or the special 'default' value.
    this.uuid = uuid;

    this.log = ModelServer.getLog();
}

ModelServer.prototype.getValue = function () {
    return jsprim.deepCopy(this.value);
};


/**
 *
 * One-time initialization for some things like logs and caching.
 */

ModelServer.init = function (app) {
    this.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelServer[p] = ModelBase.staticFn[p];
    });

    ModelServer.tasks = {};
    ModelServer.log = app.getLog();
};


/**
 * Return a list of servers matching given criteria.
 */

ModelServer.list = function (params, callback) {
    assert.optionalNumber(params.limit, 'params.limit');
    assert.optionalNumber(params.offset, 'params.offset');

    var self = this;

    var uuid = params.uuid;
    callback = once(callback);

    var extras = params.extras || { status: true, last_heartbeat: true };

    this.log.debug(params, 'Listing servers');

    var filterParams = [
        'datacenter',
        'setup',
        'reservoir',
        'headnode',
        'reserved',
        'hostname'
    ];
    var filter = '';

    if (Array.isArray(uuid)) {
        var uuidFilter = uuid.map(function (u) {
            return '(uuid=' + u + ')';
        }).join('');
        filter += '(|' + uuidFilter + ')';
    } else if (uuid) {
        filter += '(uuid=' + uuid + ')';
    } else {
        filter += '(uuid=*)';
    }

    var paramsFilter = [];
    filterParams.forEach(function (p) {
        if (!params.hasOwnProperty(p) || typeof (params[p]) === 'undefined') {
            return;
        }

        if (!buckets.servers.bucket.index[p]) {
            return;
        }

        if (buckets.servers.bucket.index[p].type === 'string') {
            paramsFilter.push(
                sprintf('(%s=%s)', p, common.filterEscape(params[p])));
        } else if (buckets.servers.bucket.index[p].type === 'number') {
            paramsFilter.push(
                sprintf('(%s=%s)', p, common.filterEscape(params[p])));
        } else if (buckets.servers.bucket.index[p].type === 'boolean') {
            paramsFilter.push(
                sprintf('(%s=%s)', p, common.filterEscape(params[p])));
        }
    });

    paramsFilter.push('!(uuid=default)');

    if (paramsFilter.length > 1) {
        filter = sprintf('(&%s(&%s))', filter, paramsFilter.join(''));
    } else if (paramsFilter.length === 1) {
        filter = sprintf('(&%s%s)', filter, paramsFilter[0]);
    }

    var moray = ModelServer.getMoray();

    var findOpts = {
            sort: {
                attribute: 'uuid',
                order: 'ASC'
            }
        };

    if (params.limit !== undefined) {
        findOpts.limit = params.limit;
    }
    if (params.offset !== undefined) {
        findOpts.offset = params.offset;
    }

    var servers = [];

    var req = moray.findObjects(
        buckets.servers.name,
        filter,
        findOpts);

    req.on('error', _onError);
    req.on('record', _onRecord);
    req.on('end', _onEnd);

    function _onError(error) {
        self.log.error(error, 'error retriving servers');
        callback(error);
    }

    function _onRecord(server) {
        servers.push(server.value);
    }

    function _onEnd() {
        async.map(
            servers,
            function (server, cb) {
                var serverModel = new ModelServer(server.uuid);

                serverModel.getFinal({
                    extras: extras,
                    serverObj: server
                }, function _gotFinal(error, s) {
                    cb(null, s);
                });
            },
            function (error, results) {
                callback(null, results);
            });
    }
};


/**
 * Creates an object that will contain default values for new servers.
 */
ModelServer.setDefaultServer = function (values, callback) {
    var self = this;

    var defaultServer;

    if (arguments.length === 2) {
        defaultServer = {
            uuid: 'default'
        };
        for (var k in values) {
            defaultServer[k] = values[k];
        }
        storeDefault();
    } else {
        defaultServer = {
            uuid: 'default',
            default_console: 'serial',
            serial: 'ttyb',
            boot_params: {},
            kernel_flags: {},
            boot_modules: [],
            boot_platform: ModelServer.getApp().liveimage
        };
        callback = arguments[0];
        storeDefault();
    }

    function storeDefault() {
        var moray = ModelServer.getMoray();

        moray.putObject(
            buckets.servers.name,
            'default',
            defaultServer,
            function (putError) {
                if (putError) {
                    self.log.error('Could not store default server');
                    callback(
                        VError(putError, 'failed to store default server'));
                    return;
                }
                callback();
            });
    }
};


ModelServer.updateDefaultServer = function (values, callback) {
    var self = this;
    var moray = ModelServer.getMoray();

    moray.getObject(
        buckets.servers.name,
        'default',
        function (error, obj) {
            if (error) {
                self.log.error(error, 'Could not store default server');
                callback(new VError(error, 'failed to store default server'));
                return;
            }

            var server = obj.value;
            if (!server.boot_params) {
                server.boot_params = {};
            }

            if (values.boot_modules) {
                server.boot_modules = values.boot_modules;
            }

            if (values.boot_platform) {
                server.boot_platform = values.boot_platform;
            }

            if (values.boot_modules) {
                server.boot_modules = values.boot_modules;
            }

            var boot_params = values.boot_params || {};
            var kernel_flags = values.kernel_flags || {};
            var k;

            for (k in kernel_flags) {
                if (kernel_flags[k] === null) {
                    delete server.kernel_flags[k];
                    continue;
                }
                server.kernel_flags = server.kernel_flags || {};
                server.kernel_flags[k] = kernel_flags[k];
            }

            for (k in boot_params) {
                if (boot_params[k] === null) {
                    delete server.boot_params[k];
                    continue;
                }
                server.boot_params = server.boot_params || {};
                server.boot_params[k] = boot_params[k];
            }

            var names = ['default_console', 'serial'];

            names.forEach(function (n) {
                if (values[n] === null) {
                    delete server[n];
                    return;
                }
                server[n] = values[n] || server[n];
            });


            moray.putObject(
                buckets.servers.name,
                'default',
                server,
                function (putError) {
                    if (putError) {
                        self.log.error('Could not store default server');
                        callback(VError(putError,
                                        'failed to store default server'));
                        return;
                    }
                    callback();
                });
        });
};


/**
 * Execute a command on a particular server via Ur.
 */

ModelServer.prototype.invokeUrScript =
function (script, params, callback) {
    var self = this;
    var uuid = this.uuid;

    var opts = {
        uuid: uuid,
        message: {
            type: 'script',
            script: script,
            args: params.args || [],
            env: params.env || {}
        }
    };
    self.log.info('Sending compute node %s script', uuid);

    ModelServer.getUr().execute(opts, function (err, stdout, stderr,
        exit_status) {

        if (err) {
            self.log.error({
                err: err,
                exit_status: exit_status,
                stderr: stderr,
                stdout: stdout
            }, 'Error raised by ur when running script');
            return callback(err);
        }

        return callback(err, stdout, stderr, exit_status);
    });
};



/**
 * Reboot a server.
 */

ModelServer.prototype.reboot = function (params, callback) {
    var self = this;

    if (!callback) {
        callback = params;
    }

    var uuid = self.uuid;
    var wfParams = {
        cnapi_url: ModelServer.getConfig().cnapi.url,
        server_uuid: uuid,
        target: uuid,
        origin: params.origin,
        creator_uuid: params.creator_uuid,
        drain: params.drain || false,
        supportsServerRebootTask: params.supportsServerRebootTask || false
    };

    self.log.info('Instantiating server-reboot workflow');
    ModelServer.getWorkflow().getClient().createJob(
        'server-reboot',
        wfParams,
        function (error, job) {
            if (error) {
                self.log.error('Error in workflow: %s', error.message);
                callback(error);
                return;
            }
            callback(null, job.uuid);
            return;
        });
};


/**
 * Format an error message with
 */

ModelServer.prototype.errorFmt = function (str) {
    return sprintf('Error (server=%s): %s', this.uuid, str);
};


/**
 * Logs an error message along with the relevant error object.
 */

ModelServer.prototype.logerror = function (error, str) {
    var self = this;
    this.log.error(error, self.errorFmt(str));
};


/**
 * Fetches and returns the server's values and merges
 * them with the raw internal values.
 */

ModelServer.prototype.filterFields = function (fields, callback) {
    var self = this;

    var server = jsprim.deepCopy(self.value);

    function isBoolean(a) {
        return !!a === a;
    }

    function skip(f, fo) {
        var ret = (
            !isBoolean(fo[f]) ||
            !fo[f]);
        return ret;
    }

    async.parallel([
        function (cb) {
            if (skip('last_heartbeat', fields)) {
                delete server.last_heartbeat;
                cb();
                return;
            }
            cb();
        },
        function (cb) {
            if (skip('status', fields)) {
                delete server.status;
                cb();
                return;
            }

            server.status = server.status || 'unknown';
            self.log.debug(
                'Status for %s was %s', self.uuid, server.status);
            cb();
        },
        function (cb) {
            if (skip('memory', fields)) {
                for (var k in MEMORY_USAGE_KEYS) {
                    delete server[MEMORY_USAGE_KEYS[k]];
                }
                cb();
                return;
            }
            cb();
        },
        function (cb) {
            if (skip('disk', fields)) {
                for (var k in DISK_USAGE_KEYS) {
                    delete server[DISK_USAGE_KEYS[k]];
                }
                cb();
                return;
            }
            cb();
        },
        function (cb) {
            if (skip('vms', fields)) {
                delete server.vms;
                cb();
                return;
            }
            cb();
        },
        function (cb) {
            if (skip('agents', fields)) {
                delete server.agents;
                cb();
                return;
            }
            cb();
        }
    ],
    function (error) {
        if (error) {
            callback(error);
            return;
        }
        callback(null, server);
    });
};


//
// cn-agent sends "status" updates for each server every minute that look like:
//
//   {
//      "server_uuid": "66345530-9491-9e42-972b-ed9a529a4a9a",
//      "vms": {
//        "9edf7ee3-86c3-40ef-be3b-ec8f73c3d747": {
//          "brand": "joyent-minimal",
//          "cpu_cap": 100,
//          "last_modified": "2019-02-06T18:49:14.000Z",
//          "max_physical_memory": 128,
//          "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
//          "quota": 25,
//          "state": "running",
//          "uuid": "9edf7ee3-86c3-40ef-be3b-ec8f73c3d747",
//          "zone_state": "running"
//        },
//        ...
//      },
//      "zpoolStatus": {
//        "zones": {
//          "bytes_available": 199334836736,
//          "bytes_used": 7662300672
//        }
//      },
//      "meminfo": {
//        "availrmem_bytes": 5325869056,
//        "arcsize_bytes": 1331352848,
//        "total_bytes": 8579944448
//      },
//      "diskinfo": {
//        "kvm_zvol_used_bytes": 0,
//        "kvm_zvol_volsize_bytes": 0,
//        "kvm_quota_bytes": 0,
//        "kvm_quota_used_bytes": 0,
//        "zone_quota_bytes": 0,
//        "zone_quota_used_bytes": 0,
//        "cores_quota_bytes": 0,
//        "cores_quota_used_bytes": 0,
//        "installed_images_used_bytes": 0,
//        "pool_size_bytes": 206997137408,
//        "pool_alloc_bytes": 7662300672,
//        "system_used_bytes": 7662300672
//      },
//      "boot_time": "2019-02-06T18:45:01.000Z",
//      "timestamp": "2019-02-14T00:29:46.183Z"
//    }
//
// We take that data here and update the server object's properties.
//
ModelServer.prototype.updateFromStatusUpdate =
function (statusUpdate, callback) {
    var self = this;

    var serverUuid = self.uuid;
    var updateObj = {};

    self.log.trace({
        statusUpdate: statusUpdate,
        serverUuid: serverUuid
    }, 'updateFromStatusUpdate');

    vasync.pipeline({funcs: [
        updateMemory,
        updateDisk,
        updateVms,
        writeServerRecord
    ]}, function (error) {
        callback(error);
    });

    function updateMemory(_, cb) {
        var memoryKeys = [
            ['availrmem_bytes', 'memory_available_bytes'],
            ['arcsize_bytes', 'memory_arc_bytes'],
            ['total_bytes', 'memory_total_bytes'] ];

        memoryKeys.forEach(function (keys) {
            if (statusUpdate.meminfo &&
                statusUpdate.meminfo.hasOwnProperty(keys[0]))
            {
                updateObj[keys[1]] = statusUpdate.meminfo[keys[0]];
            } else {
                self.log.warn('update missing "%s" property', keys[0]);
            }
        });

        cb();
    }

    function updateDisk(_, cb) {
        var diskKeys = [
            ['cores_quota_bytes', 'disk_cores_quota_bytes'],
            ['cores_quota_used_bytes', 'disk_cores_quota_used_bytes'],
            ['installed_images_used_bytes', 'disk_installed_images_used_bytes'],
            ['kvm_quota_bytes', 'disk_kvm_quota_bytes'],
            ['kvm_quota_used_bytes', 'disk_kvm_quota_used_bytes'],
            ['kvm_zvol_used_bytes', 'disk_kvm_zvol_used_bytes'],
            ['kvm_zvol_volsize_bytes', 'disk_kvm_zvol_volsize_bytes'],
            ['pool_alloc_bytes', 'disk_pool_alloc_bytes'],
            ['pool_size_bytes', 'disk_pool_size_bytes'],
            ['system_used_bytes', 'disk_system_used_bytes'],
            ['zone_quota_bytes', 'disk_zone_quota_bytes'],
            ['zone_quota_used_bytes', 'disk_zone_quota_used_bytes']
        ];

        diskKeys.forEach(function (keys) {
            if (statusUpdate.diskinfo &&
                statusUpdate.diskinfo.hasOwnProperty(keys[0]))
            {
                updateObj[keys[1]] = statusUpdate.diskinfo[keys[0]];
            } else {
                self.log.warn('update missing "%s" property', keys[0]);
            }
        });

        cb();
    }

    function updateVms(_, cb) {
        assert.object(statusUpdate.vms, 'statusUpdate.vms');

        updateObj.vms = statusUpdate.vms;
        cb();
    }

    function writeServerRecord(_, cb) {
        self.log.trace({
            updateObj: updateObj,
            serverUuid: serverUuid
        }, 'updateFromStatusUpdate update');

        ModelServer.upsert(serverUuid, updateObj, {
            etagRetries: 0
        }, cb);
    }
};


/**
 * Returns a copy of the server model's internal representation retrieved from
 * moray. Sets self.value to server object.
 */

ModelServer.prototype.getRaw = function getRaw(callback) {
    var self = this;

    assert.func(callback, 'callback');

    var uuid = self.uuid;
    var server;

    this.log.trace('Fetching server %s from moray', uuid);

    ModelServer.getMoray().getObject(
        buckets.servers.name,
        uuid,
        function (error, obj) {
            if (error && VError.hasCauseWithName(error, 'ObjectNotFoundError'))
            {
                self.log.error('Server %s not found in moray', uuid);
                callback();
                return;
            } else if (error) {
                self.log.error(error, 'Error fetching server from moray');
                callback(error);
                return;
            }

            server = jsprim.deepCopy(obj.value);
            self.value = obj.value;

            callback(null, server);
        });
};


/**
 * Create a server object suitable for insertion into Moray
 */

ModelServer.initialValues = function (opts, callback) {
    var self = this;
    var boot_params;

    async.waterfall([
        function (cb) {
            ModelServer.getBootParamsDefault(
                function (error, params) {
                    boot_params = params;

                    if (boot_params && boot_params.kernel_args &&
                        boot_params.kernel_args.rabbitmq_dns) {

                        boot_params.kernel_args.rabbitmq
                            = boot_params.kernel_args.rabbitmq_dns;
                        delete boot_params.kernel_args.rabbitmq_dns;
                    }

                    cb();
                });
        }
    ],
    function (error) {
        if (error) {
            callback(error);
            return;
        }
        var server = {};

        server.agents = [];
        server.comments = '';
        server.datacenter = ModelServer.getConfig().datacenter_name;
        server.rack_identifier = '';
        server.reservation_ratio = 0.15;
        server.reserved = false;
        server.reservoir = false;
        server.status = 'running';
        server.sysinfo = {};
        server.traits = {};
        server.uuid = self.uuid;
        server.vms = {};

        if (boot_params) {
            server.boot_params = boot_params.kernel_args;
            server.boot_platform = boot_params.platform;
            server.default_console = boot_params.default_console;
            server.kernel_flags = boot_params.kernel_flags;
            server.serial = boot_params.serial;
        }

        // set defaults if not set above
        server.boot_params = server.boot_params || {};
        server.default_console = server.default_console || 'serial';
        server.kernel_flags = server.kernel_flags || {};
        server.serial = server.serial || 'ttyb';

        server.created = (new Date()).toISOString();

        callback(null, server);
    });
};


ModelServer._addHeartbeatInfo = function _addHeartbeatInfo(serverObj) {
    assert.object(serverObj, 'serverObj');
    if (serverObj.uuid !== 'default') {
        assert.uuid(serverObj.uuid, 'serverObj.uuid');
    }

    var uuid = serverObj.uuid;
    var heartbeatInfo = ModelServer.getApp().observedHeartbeats[uuid];

    /*
     * If:
     *
     *  - we're the only CNAPI, or we happen to be the CNAPI handling this CN
     *  - the server is running
     *  - we have seen a heartbeat for this server since we started
     *
     * we'll be able to include the last_heartbeat value we've got. Otherwise
     * we'll set it to null.
     *
     * NOTE: this field is deprecated, and still exists only for backward
     * compatibility. All code for extras=last_heartbeat can be removed in a
     * future version and all consumers should stop relying on it.
     *
     */
    if (heartbeatInfo && heartbeatInfo.last_heartbeat !== undefined) {
        serverObj.last_heartbeat = heartbeatInfo.last_heartbeat;
    } else {
        serverObj.last_heartbeat = null;
    }
};


ModelServer.get = function (uuid, callback) {
    var server = new ModelServer(uuid);

    server.getRaw(function _gotRaw(err, serverobj) {
        if (!err && serverobj) {
            // We always add last_heartbeat when handling ServerGet
            ModelServer._addHeartbeatInfo(serverobj);
        }

        callback(err, server, serverobj);
    });
};


/**
 * Delete all references to a server.
 */

ModelServer.prototype.del = function (callback) {
    var self = this;
    self.log.info('Deleting server %s from moray', self.uuid);
    ModelServer.getMoray().delObject(
        buckets.servers.name,
        self.uuid,
        function (error) {
            callback(error);
        });
};


/**
 * Initialize the internal server representation.
 */

ModelServer.prototype.setRaw = function (raw, callback) {
    this.value = jsprim.deepCopy(raw);
};


/**
 * Filter the server attributes based on fields passed in.
 */

ModelServer.prototype.getFinal = function (opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.optionalObject(opts.extras, 'opts.extras');
    assert.optionalObject(opts.serverObj, 'opts.serverObj');
    assert.func(callback, 'callback');

    var extrasAll = {
        agents: true,
        disk: true,
        last_heartbeat: true,
        memory: true,
        status: true,
        sysinfo: true,
        vms: true
    };
    var extrasDefaults = {
        agents: false,
        disk: false,
        last_heartbeat: false,
        memory: false,
        status: true,
        sysinfo: false,
        vms: false
    };

    var extras = opts.extras || {};
    if (extras.all) {
        extras = extrasAll;
    } else {
        for (var extraKey in extrasDefaults) {
            if (!extras.hasOwnProperty(extraKey)) {
                extras[extraKey] = extrasDefaults[extraKey];
            }
        }
    }

    var server;

    async.waterfall([
        function (cb) {
            if (opts.serverObj) {
                // Users of this are responsible to make sure they got an object
                // with all the extras they wanted.
                self.value = opts.serverObj;
                cb();
                return;
            }
            self.getRaw(function (getError, s) {
                if (getError) {
                    cb(getError);
                    return;
                }

                // We called getRaw only for its side-effect here of setting
                // self.value. self.filterFields will then use this self.value.
                cb();
            });
        },
        function _addLastHeartbeatIfRequested(cb) {
            if (self.value && extras.last_heartbeat) {
                ModelServer._addHeartbeatInfo(self.value);
            }
            cb();
        },
        function (cb) {
            self.filterFields(extras, function (filterError, s) {
                server = s;
                cb(filterError);
            });
        },
        function (cb) {
            if (server.overprovision_ratios) {
                var v = qs.parse(server.overprovision_ratios,
                    { allowDots: false, plainObjects: false });

                // Convert number values to strings
                Object.keys(v).forEach(function (k) {
                    v[k] = +v[k];
                });
                server.overprovision_ratios = v;
            } else {
                delete server.overprovision_ratios;
            }
            cb();
        },
        function (cb) {
            //
            // transitional_status has one use-case, and that's when a server is
            // being rebooted, we set transitional_status=rebooting (in
            // the server-reboot job). The status field on the server object
            // will then show 'rebooting' instead of unknown while it's not
            // responding due to being rebooted. Consumers of CNAPI should never
            // look at this field since it is an implementation detail. They
            // should only look at status.
            //
            if (server.status === 'unknown' && server.transitional_status) {
                server.status = server.transitional_status;
            }
            cb();
        }
    ],
    function (error) {
        callback(error, server);
    });
};



/**
 * Compare the VMs given in a vmUpdate with those stored in moray for a
 * particular server.
 */
ModelServer.carryForwardVMChanges =
function (statusUpdate, serverobj) {
    var self = this;

    var vms = {};
    var vmuuid;

    if (!serverobj.vms) {
        self.log.warn('server vms member empty');
        serverobj.vms = {};
    }

    if (!statusUpdate.vms) {
        self.log.warn({ server: this.uuid }, 'Status update is missing VMs');
        serverobj.vms = {};
        return;
    }

    for (vmuuid in statusUpdate.vms) {
        if (!serverobj.vms[vmuuid]) {
            self.log.trace({ vm_uuid: vmuuid },
                'VMs update shows vm changed (now exists)');
        }

        vms[vmuuid] = statusUpdate.vms[vmuuid];

        if (serverobj.vms[vmuuid] &&
            serverobj.vms[vmuuid].last_modified !==
            statusUpdate.vms[vmuuid].last_modified)
        {
            self.log.trace({ vm_uuid: vmuuid },
                'changed because last modified changed');
        }
    }

    serverobj.vms = vms;
};


/**
 * Initiate a workflow which orchestrates and executes the steps required to
 * set up new server.
 */

ModelServer.prototype.setup = function (params, callback) {
    var self = this;

    var job_uuid;
    var uuid = this.uuid;
    var wfParams;

    wfParams = {
        // Set nic action to update, so that we add the nic tags
        // rather than replace or delete
        nic_action: 'update',
        amqp_host: ModelServer.getConfig().amqp.host,
        cnapi_url: ModelServer.getConfig().cnapi.url,
        assets_url: ModelServer.getConfig().assets.url,
        server_uuid: uuid,
        target: uuid
    };

    if (params.hasOwnProperty('nics')) {
        wfParams.nics = params.nics;
    }

    if (params.hasOwnProperty('postsetup_script')) {
        wfParams.postsetup_script = params.postsetup_script;
    }

    if (params.hasOwnProperty('hostname') && params.hostname) {
        wfParams.hostname = params.hostname;
    }

    if (params.hasOwnProperty('origin') && params.origin) {
        wfParams.origin = params.origin;
    }

    if (params.hasOwnProperty('creator_uuid') && params.creator_uuid) {
        wfParams.creator_uuid = params.creator_uuid;
    }

    if (params.hasOwnProperty('disk_spares')) {
        wfParams.disk_spares = params.disk_spares;
    }

    if (params.hasOwnProperty('disk_width')) {
        wfParams.disk_width = params.disk_width;
    }

    // Caching is the default, we only need to pass in disk cache
    // when it's false:
    if (params.hasOwnProperty('disk_cache') &&
        params.disk_cache === false) {
        wfParams.disk_cache = params.disk_cache;
    }

    if (params.hasOwnProperty('disk_layout') && params.disk_layout) {
        wfParams.disk_layout = params.disk_layout;
    }

    vasync.pipeline({funcs: [
        function _optionallySetHostname(_, cb) {
            if (params.hasOwnProperty('hostname') && params.hostname) {
                ModelServer.upsert(self.uuid, {hostname: params.hostname}, {
                    etagRetries: 0,
                    overrideNonUpdatable: true
                }, cb);
            } else {
                cb();
            }
        }, function _instantiateSetupWorkflow(_, cb) {
            self.log.info('Instantiating server-setup workflow');
            ModelServer.getWorkflow().getClient().createJob(
                'server-setup',
                wfParams,
                function (error, job) {
                    if (error) {
                        self.log.error(
                            'Error in workflow: %s', error.message);
                        cb(error);
                        return;
                    }
                    job_uuid = job.uuid;
                    cb();
                    return;
                });
        }
    ]}, function (err) {
        callback(err, job_uuid);
    });
};

/**
 * Factory reset a server.
 */

ModelServer.prototype.factoryReset = function (opts, callback) {
    var self = this;

    var uuid = this.uuid;

    var params = {
        cnapi_url: ModelServer.getConfig().cnapi.url,
        napi_url: ModelServer.getConfig().napi.url,
        assets_url: ModelServer.getConfig().assets.url,
        server_uuid: uuid,
        target: uuid,
        origin: opts.origin,
        creator_uuid: opts.creator_uuid
    };

    self.log.info('Instantiating server-factory-reset workflow');

    ModelServer.getWorkflow().getClient().createJob(
        'server-factory-reset',
        params,
        function (error, job) {
            if (error) {
                self.log.error('Error in workflow: %s', error.message);
                callback(error);
                return;
            }
            callback(null, job.uuid);
            return;
        });
};


/**
 * Return the default boot parameters to be used when booting a server.
 */
ModelServer.getBootParamsDefault = function (callback) {
    var params = {
        platform: 'latest',
        kernel_args: {},
        kernel_flags: {}
    };

    params.kernel_args.rabbitmq = [
        ModelServer.getConfig().amqp.username || 'guest',
        ModelServer.getConfig().amqp.password || 'guest',
        ModelServer.getConfig().amqp.host,
        ModelServer.getConfig().amqp.port || 5672
    ].join(':');

    ModelServer.getMoray().getObject(
        buckets.servers.name,
        'default',
        function (getError, obj) {
            if (getError) {
                callback(new VError(getError, 'getting default object'));
                return;
            }

            var server = obj.value;
            params.platform = server.boot_platform;
            var k;
            for (k in server.boot_params) {
                params.kernel_args[k] = server.boot_params[k];
            }
            for (k in server.kernel_flags) {
                params.kernel_flags[k] = server.kernel_flags[k];
            }

            /*
             * We want to default new / factory-reset CNs to picking up the SAPI
             * default. The default boot params are originally generated via
             * initializeBuckets(), but we want this policy to apply on a DC
             * upgrade, not just a completely fresh install. So we directly mix
             * in the SAPI default here.
             */
            if (!params.kernel_args.hasOwnProperty('smt_enabled')) {
                params.kernel_args['smt_enabled'] =
                    ModelServer.getConfig().cnapi.smt_enabled_default;
            }

            params.boot_modules = server.boot_modules;

            params.default_console = server.default_console;
            params.serial = server.serial;

            var parts = params.kernel_args.rabbitmq.split(':');
            var host = parts[2];

            if (host === 'localhost') {
                params.kernel_args.rabbitmq_dns = params.kernel_args.rabbitmq;
                callback(null, params);
                return;
            }

            if (host && host.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)) {
                callback(null, params);
                return;
            } else {
                dns.resolve(host, function (error, addrs) {
                    if (error) {
                        callback(error);
                        return;
                    }

                    host = addrs[Math.floor(Math.random() * addrs.length)];
                    parts[2] = host;

                    params.kernel_args.rabbitmq_dns =
                        params.kernel_args.rabbitmq;
                    params.kernel_args.rabbitmq = parts.join(':');

                    callback(null, params);
                    return;
                });
            }
        });
};


/**
 * Return the boot parameters to be used when booting a particular server.
 */

ModelServer.prototype.getBootParams = function (callback) {
    var self = this;

    self.getRaw(function (error, server) {
        if (error) {
            callback(error);
            return;
        }

        if (!server) {
            callback(null, null);
            return;
        }

        var params = {
            platform: server.boot_platform,
            kernel_args: {
                hostname: server.hostname
            },
            kernel_flags: {}
        };

        params.kernel_args.rabbitmq = [
            ModelServer.getConfig().amqp.username || 'guest',
            ModelServer.getConfig().amqp.password || 'guest',
            ModelServer.getConfig().amqp.host,
            ModelServer.getConfig().amqp.port || 5672
        ].join(':');

        // Mix in the parameters from Moray.
        var bootParams = server.boot_params || {};
        var kernelFlags = server.kernel_flags || {};
        var bootModules = server.boot_modules || [];

        var i;
        for (i in bootParams) {
            if (!bootParams.hasOwnProperty(i)) {
                continue;
            }
            params.kernel_args[i] = bootParams[i];
        }
        for (i in kernelFlags) {
            if (!kernelFlags.hasOwnProperty(i)) {
                continue;
            }
            params.kernel_flags[i] = kernelFlags[i];
        }

        params.boot_modules = bootModules;

        params.default_console = server.default_console;
        params.serial = server.serial;

        var parts = params.kernel_args.rabbitmq.split(':');
        var host = parts[2];

        if (host === 'localhost') {
            params.kernel_args.rabbitmq_dns = params.kernel_args.rabbitmq;
            callback(null, params);
            return;
        }

        if (host && host.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)) {
            callback(null, params);
            return;
        } else {
            dns.resolve(host, function (dnserror, addrs) {
                if (dnserror) {
                    callback(dnserror);
                    return;
                }

                host = addrs[Math.floor(Math.random() * addrs.length)];
                parts[2] = host;

                params.kernel_args.rabbitmq_dns = params.kernel_args.rabbitmq;
                params.kernel_args.rabbitmq = parts.join(':');

                callback(null, params);
                return;
            });
        }
    });
};


/**
 * Set the boot parameters on a server object, replace all existing
 * bootparams for this server.
 */

ModelServer.prototype.setBootParams = function (bootParams, callback) {
    var self = this;

    var payload = {
        boot_modules: bootParams.boot_modules || [],
        boot_params: bootParams.boot_params,
        boot_platform: bootParams.boot_platform,
        default_console: bootParams.default_console,
        kernel_flags: bootParams.kernel_flags || {},
        serial: bootParams.serial
    };

    ModelServer.upsert(self.uuid, payload, {
        etagRetries: 10
    }, callback);
};


/**
 * Set the boot parameters on a server object, leaving values that are not
 * being updated.
 */

ModelServer.prototype.updateBootParams = function (bootParams, callback) {
    var self = this;

    var payload = {};

    self.getRaw(function (error, server) {
        if (error) {
            self.logerror('server to be modified did not exist');
            callback(error);
            return;
        }

        if (bootParams.boot_platform) {
            payload.boot_platform = bootParams.boot_platform;
        }

        if (bootParams.boot_modules) {
            payload.boot_modules = bootParams.boot_modules;
        }

        var k;
        if (bootParams.boot_params) {
            payload.boot_params = server.boot_params;
            if (!payload.boot_params) {
                payload.boot_params = {};
            }
            for (k in bootParams.boot_params) {
                if (bootParams.boot_params[k] === null) {
                    delete payload.boot_params[k];
                    continue;
                }
                payload.boot_params[k] = bootParams.boot_params[k];
            }
        }

        if (bootParams.kernel_flags) {
            payload.kernel_flags = server.kernel_flags;
            if (!payload.kernel_flags) {
                payload.kernel_flags = {};
            }
            for (k in bootParams.kernel_flags) {
                if (bootParams.kernel_flags[k] === null) {
                    delete payload.kernel_flags[k];
                    continue;
                }
                payload.kernel_flags[k] = bootParams.kernel_flags[k];
            }
        }

        var names = ['default_console', 'serial'];

        names.forEach(function (n) {
            payload[n] = server[n];
            if (bootParams[n] === null) {
                payload[n] = '';
                return;
            }
            payload[n] = bootParams[n] || payload[n];
        });

        ModelServer.upsert(self.uuid, payload, {
            etagRetries: 10
        }, callback);
    });
};


/*
 * Initiates a cn-agent task http request.
 */

ModelServer.prototype.sendTaskRequest =
function (opts) {
    var self = this;

    self.log.info('sending task to %s', self.uuid);

    if (opts.log_params !== false) {
        self.log.info({ params: arguments[0].params }, 'task params');
    }

    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.task, 'opts.task');
    assert.object(opts.params, 'opts.params');
    assert.optionalBool(opts.persist, 'opts.persist');
    assert.string(opts.req_id, 'opts.req_id');
    assert.func(opts.cb, 'opts.cb');

    var task, params, callback, persist;

    var client;
    var serverAdminIp;
    var serverAdminPort = 5309;
    var synccb;
    var sysinfo;

    var taskstatus = {
        id: common.genId(),
        req_id: opts.req_id,
        task: opts.task,
        server_uuid: self.uuid,
        status: 'active',
        timestamp: (new Date()).toISOString()
    };

    task = opts.task;
    persist = opts.persist !== false ? true : false;
    params = opts.params;
    callback = opts.cb;
    synccb = opts.synccb;

    var log = opts.log || self.log;

    var payload = {
        task: task,
        params: params
    };

    log.info('Task id = %s', taskstatus.id);

    /**
     * Pull sysinfo for server out of moray
     * Get IP address of server from sysinfo
     * Create task payload
     */

    async.waterfall([
        // XXX this code is the same as ModelServer.prototype.sendRequest
        // could use some deduplication
        function getSysinfo(wfcb) {
            self.getRaw(function (err, server) {
                if (err) {
                    wfcb(new VError(err, err));
                    return;
                }

                if (!server) {
                    wfcb(new VError('server not found'));
                    return;
                }

                sysinfo = server.sysinfo;

                wfcb();
            });
        },
        function getCnAgentLocationFromSysinfo(wfcb) {
            /*
             * agentIpFromSysinfo() is intended for use with mockcloud which
             * requires the use of a different IP for contacting agents on a
             * mock CN.  If mockcloud support is not a requirement,
             * adminIpFromSysinfo() should be used to get the admin IP for a
             * CN.
             */
            serverAdminIp = netconfig.agentIpFromSysinfo(sysinfo);
            if (!serverAdminIp) {
                wfcb(new VError('Parsing server ip address in sendTaskReq '
                    + '(No admin NICs detected.)'));
                return;
            }

            if (sysinfo.hasOwnProperty('CN Agent Port')) {
                const port = Number.parseInt(sysinfo['CN Agent Port']);
                if (!Number.isNaN(port)) {
                    serverAdminPort = port;
                }
            }

            log.info({
                serverAdminIp: serverAdminIp,
                serverAdminPort: serverAdminPort,
                serverUuid: self.uuid,
                task: task
            }, 'found server location before task request');

            wfcb();
        },
        function (wfcb) {
            if (persist) {
                updateTask(wfcb);
                return;
            }
            wfcb();
        },
        function (wfcb) {
            var cOpts = {
                url: 'http://' + serverAdminIp + ':' + serverAdminPort,
                requestTimeout: 3600 * 1000,
                connectTimeout: 3600 * 1000
            };
            var rOpts = { path: '/tasks' };

            rOpts.headers = {
                'x-server-uuid': self.uuid,
                'x-request-id': opts.req_id
            };

            client = restify.createJsonClient(cOpts);

            log.info('posting task to %s%s (req_id=%s)',
                     cOpts.url, rOpts.path, opts.req_id);

            // write initial task to moray
            // post http request
            // on response from post, write to moray again

            // TODO get taskstatus.history from the response from cn-agent
            client.post(rOpts, payload, function (err, req, res, obj) {
                client.close();

                if (err) {
                    taskstatus.status = 'failure';

                    var message = obj && obj.error
                         ? obj.error
                         : (err.message
                            ? err.message
                            : 'no error given');

                    taskstatus.history = [
                        {
                            name: 'error',
                            timestamp: (new Date()).toISOString(),
                            event: {
                                error: {
                                    message: message
                                }
                            }
                        },
                        {
                            name: 'finish',
                            timestamp: (new Date()).toISOString(),
                            event: {}
                        }
                    ];

                    updateTask(function () {
                        ModelServer.getApp().alertWaitingTasks(
                            err, taskstatus.id, taskstatus);
                    });

                    var e = new VError(err, 'posting task to cn-agent');
                    log.error(e, 'posting task to cn-agent');
                    if (obj) {
                        e.orig = obj;
                    }

                    if (synccb) {
                        synccb(e);
                    }
                    return;
                }

                taskstatus.status = 'complete';
                taskstatus.history = [
                    {
                        name: 'finish',
                        timestamp: (new Date()).toISOString(),
                        event: obj
                    }
                ];

                if (persist) {
                    updateTask(function () {
                        ModelServer.getApp().alertWaitingTasks(
                            err, taskstatus.id, taskstatus);
                    });
                }

                if (synccb) {
                    synccb(null, obj);
                }
            });

            wfcb();
        }
    ],
    function (error) {
        if (error) {
            log.error({err: error}, 'error posting task to client');
        } else {
            log.info('done posting task to client');
        }
        callback(null, taskstatus);
    });

    function updateTask(cb) {
        var moray = ModelServer.getMoray();

        self.log.debug({ taskstatus: taskstatus },
            'sendTaskRequest: updating task value in moray');
        moray.putObject(buckets.tasks.name, taskstatus.id, taskstatus,
            function (putError) {
                if (putError) {
                    self.log.error({ err: putError },
                        'writing initial task details to moray');
                    cb(putError);
                    return;
                }

                if (cb) {
                    cb();
                }
            });
    }
};


/**
 * Send HTTP request to CN-Agent.
 *
 * For use with 'POST /tasks' end-point use 'sendTaskRequest' above
 *
 */
ModelServer.prototype.sendRequest = function (opts, cb) {
    var self = this;

    assert.string(opts.path, 'opts.path');
    assert.string(opts.method, 'opts.method');
    assert.optionalObject(opts.params, 'opts.params');
    assert.func(cb, 'cb');

    var client;
    var method = opts.method.toLowerCase();
    var params = opts.params || {};
    var serverAdminIp;
    var serverAdminPort = 5309;
    var sysinfo;

    var log = self.log;

    async.waterfall([
        // XXX this code is the same as ModelServer.prototype.sendTaskRequest
        // could use some deduplication
        function getSysinfo(wfcb) {
            self.getRaw(function (err, server) {
                if (err) {
                    wfcb(new VError(err, err));
                    return;
                }

                if (!server) {
                    wfcb(new VError('server not found'));
                    return;
                }
                sysinfo = server.sysinfo;

                log.info('sysinfo for %s before HTTP request', self.uuid);

                wfcb();
            });
        },
        function getCnapiLocationFromSysinfo(wfcb) {
            if (sysinfo.hasOwnProperty('CN Agent IP')) {
                // Allow sysinfo to include an IP that we'll use to connect to
                // that might be different from the "Admin IP".
                serverAdminIp = sysinfo['CN Agent IP'];
            } else {
                serverAdminIp = netconfig.adminIpFromSysinfo(sysinfo);
            }
            if (!serverAdminIp) {
                wfcb(new VError('parsing server ip address in sendTaskReq '
                    + '(No admin NICs detected.)'));
                return;
            }

            if (sysinfo.hasOwnProperty('CN Agent Port')) {
                const port = Number.parseInt(sysinfo['CN Agent Port']);
                if (!Number.isNaN(port)) {
                    serverAdminPort = port;
                }
            }

            log.info({
                serverAdminIp: serverAdminIp,
                serverAdminPort: serverAdminPort,
                serverUuid: self.uuid
            }, 'found server location before HTTP request');

            wfcb();
        },
        function executeRequest(wfcb) {
            var cOpts = {
                url: 'http://' + serverAdminIp + ':' + serverAdminPort,
                requestTimeout: 3600 * 1000,
                connectTimeout: 3600 * 1000
            };
            var rOpts = {
                headers: {
                    'x-server-uuid': self.uuid
                },
                path: opts.path
            };

            client = restify.createJsonClient(cOpts);

            log.info('Excuting %s request to %s%s',
                    method, cOpts.url, rOpts.path);
            function reqCb(err, req, res, obj) {
                client.close();

                if (err) {
                    wfcb(err);
                    return;
                }
                wfcb(null, obj);
            }

            if (method === 'post' || method === 'put') {
                client[method](rOpts, params, reqCb);
            } else {
                client[method](rOpts, reqCb);
            }
        }
    ],
    function (error, results) {
        log.info('done executing client request');
        cb(error, results);
    });
};

ModelServer.prototype.zfsTask = function (task, opts, callback) {
    var self = this;

    var request = {
        task: task,
        cb: function (error, taskstatus) {
        },
        synccb: function (error, result) {
            callback(error, result);
        },
        req_id: opts.req.getId(),
        params: opts.params
    };

    self.sendTaskRequest(request);
};

/**
 * Return a VM model.
 */

ModelServer.prototype.getVM =
function (uuid) {
    return new ModelVM({ serverUuid: this.uuid, uuid: uuid });
};


ModelServer.prototype.getWaitlist = function () {
    return new ModelWaitlist({ uuid: this.uuid });
};


/*
 * This function is a helper for ModelServer.upsert. It does all the work of
 * performing a single attempt, and on ETag failure, kicking off the next
 * attempt.
 */
ModelServer._attemptUpsert =
function _attemptUpsert(
    opts, serverUuid, properties, etagRetries, results, callback) {

    assert.object(opts, 'opts');
    assert.optionalBool(opts.allowCreate, 'opts.allowCreate');
    assert.optionalBool(opts.overrideNonUpdatable, 'opts.overrideNonUpdatable');
    assert.object(opts.log, 'opts.log');
    assert.uuid(serverUuid, 'serverUuid');
    assert.object(properties, 'properties');
    assert.number(etagRetries, 'etagRetries');
    assert.object(results, 'results');
    assert.object(results.stats, 'results.stats');
    assert.func(callback, 'callback');

    var modified = false;

    if (!results.stats.hasOwnProperty('getObjectAttempts')) {
        results.stats.getObjectAttempts = 0;
        results.stats.getObjectErrors = 0;
        results.stats.getObjectNotFound = 0;
        results.stats.putObjectAttempts = 0;
        results.stats.putObjectErrors = 0;
        results.stats.putObjectEtagErrors = 0;
    }

    vasync.pipeline({arg: {}, funcs: [
        function _getServer(ctx, cb) {
            ModelServer.getMoray().getObject(
                buckets.servers.name,
                serverUuid,
                function (err, obj) {
                    var requireExist = false;

                    if (opts.allowCreate === false) {
                        requireExist = true;
                    }

                    results.stats.getObjectAttempts++;

                    // Default to found until we see ObjectNotFoundError
                    ctx.serverIsNew = false;

                    if (err) {
                        if (VError.hasCauseWithName(err,
                            'ObjectNotFoundError')) {

                            results.stats.getObjectNotFound++;

                            if (!requireExist) {
                                // We're ok creating a new server.
                                ctx.serverIsNew = true;
                                cb();
                                return;
                            }
                        }

                        results.stats.getObjectErrors++;
                        cb(err);
                        return;
                    }

                    ctx.etag = obj._etag;
                    ctx.serverObj = obj.value;

                    opts.log.trace({
                        isNew: ctx.serverIsNew,
                        serverObj: ctx.serverObj
                    }, 'Got object from moray');

                    cb();
                });
        }, function _initializeIfNew(ctx, cb) {
            if (!ctx.serverIsNew) {
                cb();
                return;
            }

            ModelServer.initialValues({}, function (err, serverObj) {
                if (err) {
                    cb(err);
                    return;
                }

                opts.log.trace({
                    properties: properties,
                    serverObj: serverObj
                }, 'Initial new server');

                serverObj.uuid = serverUuid;
                ctx.serverObj = serverObj;
                modified = true; // need to write this out since it's new

                cb();
            });
        }, function _applyProperties(ctx, cb) {
            var field;
            var idx;
            var keys;
            var newServerObj = jsprim.deepCopy(ctx.serverObj);
            var reservation_ratio;
            var total_memory;
            var value;

            // Under all circumstances, we want the new object to have its
            // UUID. This guarantees we'll never write a newServerObj w/o
            // including the UUID. Even if the old object was broken and
            // missing one.
            newServerObj.uuid = serverUuid;

            keys = Object.keys(properties).filter(function (k) {
                if (ctx.serverIsNew) {
                    // On a new server, we can set all fields.
                    return true;
                }

                // For server-setup we might need to update ordinarily
                // non-updatable properties (e.g. hostname)
                if (opts.overrideNonUpdatable === true) {
                    return true;
                }

                if (NON_UPDATABLE_KEYS.indexOf(k) === -1) {
                    // not in blacklist
                    return true;
                }

                if (jsprim.deepEqual(newServerObj[k], properties[k])) {
                    // values are same, so we're not actually updating
                    return false;
                }

                opts.log.debug({
                    key: k,
                    serverUuid: serverUuid
                }, 'attempt to update non-updatable key, ignoring');

                return false;
            });

            for (idx = 0; idx < keys.length; idx++) {
                field = keys[idx];
                value = properties[field];

                if (!jsprim.deepEqual(newServerObj[field], value)) {
                    newServerObj[field] = value;
                    modified = true;
                }
            }

            // BEGIN BACKWARD COMPAT SECTION

            if (properties.sysinfo) {
                // For backward compat, we only set agents to 'SDC Agents'
                // when we don't have server.agents. Usually, agents will
                // be sent by cn-agent via 'POST /servers/<uuid>' when it
                // starts up.
                if (!newServerObj.agents ||
                    (newServerObj.agents &&
                        Array.isArray(newServerObj.agents) &&
                        newServerObj.agents.length === 0 &&
                        properties.sysinfo['SDC Agents'])) {

                    newServerObj.agents = properties.sysinfo['SDC Agents'];
                    modified = true;
                }
            }

            // For backward compat, we recalculate
            // memory_provisionable_bytes whenever we're changing any fields
            // that go into this calculation.
            //
            // In the future we should redefine how this works.
            if (newServerObj.reservation_ratio && newServerObj.vms &&
                (properties.reservation_ratio ||
                properties.vms ||
                properties.sysinfo ||
                properties.memory_total_bytes)) {

                total_memory = 0;
                if (newServerObj.sysinfo &&
                    newServerObj.sysinfo['MiB of Memory']) {

                    total_memory = newServerObj.sysinfo['MiB of Memory'] *
                        1024 * 1024;
                } else if (newServerObj.memory_total_bytes) {
                    total_memory = newServerObj.memory_total_bytes;
                }

                if (total_memory > 0) {
                    reservation_ratio = newServerObj.reservation_ratio;
                    newServerObj.memory_provisionable_bytes =
                        total_memory - (total_memory * reservation_ratio);
                    newServerObj.memory_provisionable_bytes -= 1024 * 1024 *
                        Object.keys(newServerObj.vms)
                            .map(function (uuid) {
                                return newServerObj.vms[uuid];
                            })
                            .reduce(function (prev, curr) {
                                return prev + curr.max_physical_memory;
                            }, 0);
                    newServerObj.memory_provisionable_bytes =
                        Math.floor(newServerObj.memory_provisionable_bytes);

                    modified = true;
                } else {
                    opts.log.warn('Unable to determine total memory, ' +
                        'not updating memory_provisionable_bytes');
                }
            }

            // DAPI hardcodes all overprovision_ratio values, so we don't
            // bother storing these to the object. Eventually overprovisioning
            // will go away, sanity will prevail, and this will no longer be
            // necessary.
            delete newServerObj.overprovision_ratios;

            //
            // Since transitional_status is only currently used for 'rebooting',
            // we can clear it any time it is set and the last_boot value is
            // changing since that means the server has completed a reboot. But
            // we only want to do that when the status is 'running' otherwise
            // we'd potentially have a transition:
            //
            //  running -> rebooting -> unknown -> running
            //
            // so to ensure this doesn't happen, we clear the transition when:
            //
            //  * the last_boot changes and the server is "running"
            //  * the state changes from unknown -> running
            //
            // this way if the server reboots so quickly that it never gets
            // marked status=unknown, we'll clear the transition when the
            // last_boot changed (since status=running then). And if the server
            // reboots more slowly, we'll catch it on the first transition to
            // running.
            //
            if (ctx.serverObj.transitional_status) {
                // We expect anything other than empty string or undefined
                // should be 'rebooting'. If someone adds another case without
                // updating this, we want to blow up.
                assert.equal(ctx.serverObj.transitional_status, 'rebooting',
                    'unexpected transitional_status=' +
                    ctx.serverObj.transitional_status +
                    ' for server ' + ctx.serverObj.uuid);

                if ((newServerObj.status === 'running') &&
                    ((ctx.serverObj.last_boot !== newServerObj.last_boot) ||
                        ctx.serverObj.status === 'unknown')) {

                    delete newServerObj.transitional_status;
                    modified = true;
                }
            }

            // END BACKWARD COMPAT SECTION

            ctx.newServerObj = newServerObj;

            cb();
        }, function _removeIllegalProperties(ctx, cb) {
            var extraProps;
            var idx;
            var prop;

            if (!modified) {
                // Don't worry about extra properties if we're not going to
                // write anyway.
                cb();
                return;
            }

            extraProps =
                jsprim.extraProperties(ctx.newServerObj, SERVER_KEYS);

            if (extraProps.length > 0) {
                opts.log.warn({unexpectedProps: extraProps},
                    'Object has unexpected properties');
            }

            for (idx = 0; idx < extraProps.length; idx++) {
                 prop = extraProps[idx];
                 delete ctx.newServerObj[prop];
            }

            cb();
        }, function _putObject(ctx, cb) {
            var putOpts = {};

            if (!modified) {
                cb();
                return;
            }

            if (ctx.etag) {
                putOpts.etag = ctx.etag;
            }

            opts.log.trace({
                diff: deepDiff(ctx.serverIsNew ?  {} : ctx.serverObj,
                    ctx.newServerObj),
                putOpts: putOpts,
                serverUuid: ctx.newServerObj.uuid
            }, 'Writing change');

            results.stats.putObjectAttempts++;

            ModelServer.getMoray().putObject(
                buckets.servers.name,
                ctx.newServerObj.uuid,
                ctx.newServerObj,
                putOpts,
                function (err) {
                    opts.log[err ? 'warn' : 'trace']({
                        err: err,
                        uuid: ctx.newServerObj.uuid,
                        value: ctx.newServerObj
                    }, 'Upsert putObject');

                    if (err) {
                        results.stats.putObjectErrors++;
                        if (VError.hasCauseWithName(err, 'EtagConflictError')) {
                            results.stats.putObjectEtagErrors++;
                        }
                    }

                    cb(err);
                });
        }
    ]}, function _triedPut(err) {
        if (err && VError.hasCauseWithName(err, 'EtagConflictError') &&
            etagRetries > 0) {

            setImmediate(ModelServer._attemptUpsert,
                opts,
                serverUuid,
                properties,
                etagRetries - 1,
                results,
                callback);

            return;
        }

        callback(err, results);
    });
};


/*
 * This function takes a serverUuid and some properties and then:
 *
 *  - tries to get the existing server object with this uuid from moray
 *  - if the server does not exist, a fresh server object is created
 *  - the properties are then applied to the server object
 *  - the resulting object is written out to moray
 *
 * If the final write fails due to an ETag error, and opts.etagRetries is set to
 * a value > 0, the whole process is immediately retried by calling itself again
 * after decrementing etagRetries.
 *
 * The intention is that this is the only function that actually writes server
 * records to Moray, so that we can ensure this is handled in a consistent way.
 *
 * The callback will be called:
 *
 *   callback(err, results)
 *
 * where 'err' is an Error object, or undefined. And 'results' is an object that
 * contains some information about what happened during the course of the
 * operation. Currently this object contains a 'stats' property which itself
 * is an object that contains 0 or more counters which indicate operations that
 * upsert performed. Currently the possible counters are:
 *
 * getObjectAttempts    -- number of getObject calls attempted
 * getObjectErrors      -- total number of getObject errors (excluding NotFound)
 * getObjectNotFound    -- number of getObject calls that found no object
 * putObjectAttempts    -- number of putObject calls attempted
 * putObjectErrors      -- total number of putObject errors
 * putObjectEtagErrors  -- number of putObject errors that were Etag conflicts
 *
 * So, results.stats.putObjectAttempts can be checked in order to see how many
 * times moray.putObject() was called. If undefined, it was never called.
 *
 */
ModelServer.upsert = function upsert(serverUuid, properties, opts, callback) {
    var self = this;

    // NOTE: we don't validate parameters here because they're validated in
    // ModelServer._attemptUpsert.

    ModelServer._attemptUpsert({
        allowCreate: opts.allowCreate,
        log: self.log,
        overrideNonUpdatable: opts.overrideNonUpdatable
    }, serverUuid, properties, opts.etagRetries || 0, {stats: {}}, callback);
};


/*
 * This can go away when TRITON-1216 is implemented and rolled out everywhere.
 */
function doNapiSysinfoUpdate(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.napi, 'opts.napi');
    assert.object(opts.sysinfo, 'opts.sysinfo');
    assert.func(callback, 'callback');

    var n;
    var nic;
    var sysinfo = opts.sysinfo;
    var t;
    var tags = [];
    var tag;

    for (n in sysinfo['Network Interfaces']) {
        nic = sysinfo['Network Interfaces'][n];
        if (nic.hasOwnProperty('NIC Names')) {
            for (t in nic['NIC Names']) {
                tag = nic['NIC Names'][t];

                if (tags.indexOf(tag) === -1) {
                    tags.push(tag);
                }
            }
        }
    }

    opts.log.info({
        serverUuid: opts.sysinfo.UUID,
        tags: tags
    }, 'Updating NAPI nic_tags due to sysinfo');

    if (tags.length === 0) {
        callback();
        return;
    }

    vasync.forEachParallel({
        inputs: tags,
        func: function (tagparam, cb) {
            opts.napi.createNicTag(tagparam, function (err, res) {
                if (err) {
                   if (!(err.body && err.body.errors &&
                       err.body.errors[0].code === 'Duplicate')) {
                       opts.log.error({
                           err: err,
                           tag: tagparam
                       }, 'Error adding nic tag to NAPI');

                       cb(err);
                       return;
                   }
                }
                cb();
            });
        }
    }, callback);
}


ModelServer.updateFromSysinfo = function updateFromSysinfo(sysinfo, callback) {
    var self = this;

    assert.object(sysinfo, 'sysinfo');
    assert.uuid(sysinfo.UUID, 'sysinfo.UUID');
    assert.func(callback, 'callback');

    var napi;
    var napiUrl = ModelServer.getConfig().napi.url;
    var serverUuid = sysinfo.UUID;
    var updateObj = {};

    napi = new sdcClients.NAPI({ url: napiUrl });

    function _setField(obj, serverField, sysinfoField, transform) {
        var value = sysinfo[sysinfoField];

        if (transform !== undefined) {
            value = transform(value);
        }

        if (value === undefined) {
            return;
        }

        obj[serverField] = value;
    }

    self.log.trace({sysinfo: sysinfo}, 'updateFromsysinfo');

    vasync.pipeline({funcs: [
        function _updateNapi(_, cb) {
            // This can go away when TRITON-1216 is implemented and rolled out
            // everywhere.
            doNapiSysinfoUpdate({
                log: self.log,
                napi: napi,
                sysinfo: sysinfo
            }, cb);
        }, function _buildUpdateObj(_, cb) {
            updateObj.sysinfo = sysinfo;

            _setField(updateObj, 'created', 'Zpool Creation', function (v) {
                if (v === undefined) {
                    return v;
                }
                return (new Date(Number(v) * 1000)).toISOString();
            });
            _setField(updateObj, 'current_platform', 'Live Image');
            _setField(updateObj, 'headnode', 'Boot Parameters', function (v) {
                if (v === undefined) {
                    return v;
                }
                return (v.headnode === 'true');
            });
            _setField(updateObj, 'hostname', 'Hostname');
            _setField(updateObj, 'last_boot', 'Boot Time', function (v) {
                if (v === undefined) {
                    return v;
                }
                return (new Date(Number(v) * 1000)).toISOString();
            });
            _setField(updateObj, 'ram', 'MiB of Memory', function (v) {
                if (v === undefined) {
                    return v;
                }
                return (parseInt(v, 10));
            });
            _setField(updateObj, 'setup', 'Setup', function (v) {
                return (v === 'true' || v === true);
            });

            cb();
        }, function _doUpsert(_, cb) {
            ModelServer.upsert(serverUuid, updateObj, {
                etagRetries: 0
            }, cb);
        }
    ]}, callback);
};

module.exports = ModelServer;
