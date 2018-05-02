/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 *
 * This file contains all the Compute Server logic, used to interface with the
 * server as well as it's stored representation in the backend datastores.
 */

var async = require('async');
var assert = require('assert-plus');
var dns = require('dns');
var qs = require('querystring');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var VError = require('verror');
var once = require('once');

var buckets = require('../apis/moray').BUCKETS;
var common = require('../common');
var ModelBase = require('./base');
var ModelVM = require('./vm');
var ModelWaitlist = require('./waitlist');
var ModelPlatform = require('./platform');

var MEMORY_USAGE_KEYS = [
    'memory_available_bytes',
    'memory_arc_bytes',
    'memory_total_bytes',
    'memory_provisionable_bytes'
];

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
    this.uuid = uuid;

    this.log = ModelServer.getLog();
}

ModelServer.prototype.getValue = function () {
    return clone(this.value);
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
    ModelServer.heartbeatByServerUuid = {};
};


ModelServer.createComputeNodeAgentHandler = function (app, jobuuid) {
    var self = this;
    var workflow = ModelServer.getWorkflow();

    return function (task, event) {
        var taskid = task.id;

        if (!jobuuid) {
            return;
        }

        self.log.info(
            'Posting task info (task %s) to workflow jobs endpoint (job %s)',
            taskid, jobuuid);
        workflow.getClient().client.post(
            '/jobs/' + jobuuid + '/info',
            event,
            function (error, req, res, obj) {
                if (error) {
                    self.log.error(
                        error, 'Error posting info to jobs endpoint');
                    return;
                }
                self.log.info(
                    'Posted task info (task %s, job %s)',
                    taskid, jobuuid);
            });
    };
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

    var wantFinal = params.wantFinal;

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
    var serverStatus = {};


    async.parallel([
        // Get all server records
        function (next) {
            var req = moray.findObjects(
                buckets.servers.name,
                filter,
                findOpts);

            req.on('error', onError);
            req.on('record', onRecord);
            req.on('end', next);

            function onError(error) {
                self.log.error(error, 'error retriving servers');
                next(error);
            }

            function onRecord(server) {
                servers.push(server.value);
            }
        },

        // Get all server record last_heartbeat data
        function (next) {
            // XXX write me a getAllServerStatuses function that can return >
            // 1000 results
            if (extras.last_heartbeat === false) {
                next();
                return;
            }

            var req = moray.findObjects(
                buckets.status.name, '(server_uuid=*)', {});

            req.on('error', onError);
            req.on('record', onRecord);
            req.on('end', next);

            function onError(error) {
                self.log.error(error, 'error retriving last_heartbeats');
                next(error);
            }

            function onRecord(status) {
                serverStatus[status.value.server_uuid] =
                    status.value;
            }
        }
    ], function (err) {
        processResults(err);
    });

    function processResults(err) {
        if (err) {
            callback(err);
            return;
        }
        if (!wantFinal) {
            callback(null, servers);
            return;
        }
        async.map(
            servers,
            function (server, cb) {
                var serverModel = new ModelServer(server.uuid);

                if (serverStatus.hasOwnProperty(server.uuid)) {
                    server.last_heartbeat =
                        serverStatus[server.uuid].last_heartbeat;
                }

                serverModel.setRaw(server);

                serverModel.getFinal(extras, function (error, s) {
                    cb(null, s);
                });
            },
            function (error, results) {
                callback(null, results);
            });
    }
};



/**
 * Initiate a workflow, which can may be can be added to which is run whenever
 * a new server starts up and sends its sysinfo payload via Ur.
 */

ModelServer.beginSysinfoWorkflow = function (sysinfo, callback) {
    var self = this;

    if (!ModelServer.app.workflow.connected) {
        self.log.warn(
            'Cannot start sysinfo workflow: cannot reach workflow API');
    }

    var uuid = sysinfo.UUID;

    var params = {
        sysinfo: sysinfo,
        server_uuid: uuid,
        target: uuid,
        admin_uuid: ModelServer.getConfig().adminUuid
    };

    self.log.info('Instantiating server-sysinfo workflow');
    ModelServer.getWorkflow().getClient().createJob(
        'server-sysinfo',
        params,
        function (error, job) {
            if (error) {
                self.log.error('Error in workflow: %s', error.message);
                if (callback) {
                    callback(error);
                }
                return;
            }
            if (callback) {
                callback();
            }
        });
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

    ModelServer.getUr().execute(opts, function (err, stdout, stderr) {
        if (err) {
            self.log.error('Error raised by ur when ' +
                'running script: ' + err.message);
            return callback(err);
        }

        return callback(err, stdout, stderr);
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

    var uuid = this.uuid;
    var wfParams;

    self.getRaw(function (geterror, raw) {
        wfParams = {
            cnapi_url: ModelServer.getConfig().cnapi.url,
            server_uuid: uuid,
            target: uuid,
            origin: params.origin,
            creator_uuid: params.creator_uuid,
            drain: params.drain || false
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

    var server = clone(self.value);

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


ModelServer.prototype.updateFromVmsUpdate =
function (heartbeat, callback) {
    var self = this;

    var serverobj = {};

    async.waterfall([
        // Get the server object
        getServer,

        // Initialize the server object
        initializeServer,

        // Update the server's memory
        updateMemory,

        // Update the server's disk
        updateDisk,

        // Update the server status
        updateStatus,

        // Write the change to moray
        writeServerRecord
    ],
    function (error) {
        callback(error);
    });

    function getServer(cb) {
        self.getRaw(function (err, so, s) {
            if (err) {
                cb(new VError(err, 'retrieving server on heartbeat'));
                return;
            }

            serverobj = so;
            cb();
        });
    }

    function initializeServer(cb) {
        if (!serverobj) {
            self.log.info(
                'heartbeat server %s was not found in moray, ' +
                'initializing new server record', self.uuid);
            // Initialize new server record from default params
            ModelServer.initialValues({}, function (error, so) {
                if (error) {
                    cb(error);
                    return;
                }

                serverobj = so;
                serverobj.uuid = self.uuid;
                serverobj.vms = {};
                cb();
            });

            return;
        } else {
            if (!serverobj.sysinfo) {
                ModelServer.getApp().needSysinfoFromServer(self.uuid);
            }
            ModelServer.carryForwardVMChanges(heartbeat, serverobj);
        }

        cb();
    }

    function updateMemory(cb) {
        if (!serverobj.sysinfo) {
            cb();
            return;
        }
        var memoryKeys = [
            ['availrmem_bytes', 'memory_available_bytes'],
            ['arcsize_bytes', 'memory_arc_bytes'],
            ['total_bytes', 'memory_total_bytes'] ];

        memoryKeys.forEach(function (keys) {
            if (heartbeat.meminfo &&
                heartbeat.meminfo.hasOwnProperty(keys[0]))
            {
                serverobj[keys[1]] = heartbeat.meminfo[keys[0]];
            } else {
                self.log.warn('update missing "%s" property', keys[0]);
            }
        });

        /**
         * Compute the memory_provisionable_bytes value based on the total
         * memory, the reservation ratio and the max_physical_memory values
         * of all vms.
         */

        var reservation_ratio = serverobj.reservation_ratio;
        var total_memory_bytes
            = serverobj.sysinfo['MiB of Memory'] * 1024 * 1024;

        serverobj.memory_provisionable_bytes =
            total_memory_bytes - (total_memory_bytes * reservation_ratio);

        serverobj.memory_provisionable_bytes -= 1024 * 1024 *
            Object.keys(heartbeat.vms)
                .map(function (uuid) {
                    return heartbeat.vms[uuid];
                })
                .reduce(function (prev, curr) {
                    return prev + curr.max_physical_memory;
                }, 0);

        serverobj.memory_provisionable_bytes =
            Math.floor(serverobj.memory_provisionable_bytes);
        cb();
    }

    function updateDisk(cb) {
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
            if (heartbeat.diskinfo &&
                heartbeat.diskinfo.hasOwnProperty(keys[0]))
            {
                serverobj[keys[1]] = heartbeat.diskinfo[keys[0]];
            } else {
                self.log.warn('update missing "%s" property', keys[0]);
            }
        });

        cb();
    }

    function updateStatus(cb) {
        serverobj.status = 'running';
        serverobj.last_heartbeat = (new Date()).toISOString();
        cb();
    }

    function writeServerRecord(cb) {
        self.modify(serverobj, function (err) {
            if (err) {
                self.log.error(err);
            }
            cb(err);
        });
    }
};


/**
 * Returns a copy of the server model's internal representation retried from
 * the memory, or from memory if this object has been previously
 * fetched.
 */

ModelServer.prototype.getRaw = function (extras, callback) {
    var self = this;
    var uuid = self.uuid;
    var server;

    if (arguments.length === 1) {
        callback = extras;
        extras = {};
    }

    if (self.exists === false) {
        this.log.warn(
            '%s was not found previously, returning negative result', uuid);
        callback();
        return;
    }

    if (self.value) {
        server = clone(self.value);
        callback(null, server);
    } else {
        this.log.trace('Fetching server %s from moray', uuid);
        ModelServer.getMoray().getObject(
            buckets.servers.name,
            uuid,
            function (error, obj) {
                if (error && VError.hasCauseWithName(error,
                                                     'ObjectNotFoundError'))
                {
                    self.exists = false;
                    self.log.error('Server %s not found in moray', uuid);

                    callback();
                    return;
                } else if (error) {
                    self.log.error(error, 'Error fetching server from moray');
                    callback(error);
                    return;
                }
                self.found = true;
                self.exists = true;
                server = clone(obj.value);
                self.value = obj.value;


                if (extras.last_heartbeat) {
                    ModelServer.getMoray().getObject(
                        buckets.status.name,
                        uuid,
                        function (getStatusError, statusObj) {
                            if (getStatusError &&
                                VError.hasCauseWithName(getStatusError,
                                                        'ObjectNotFoundError'))
                            {
                                self.log.error(
                                    'last_heartbeat for %s not found in moray',
                                    uuid);

                                self.value.last_heartbeat =
                                    server.last_heartbeat =
                                    null;

                                callback(null, server);
                                return;
                            } else if (getStatusError) {
                                self.log.error(getStatusError,
                                    'Error fetching last heartbeat from moray');
                                callback(error);
                                return;
                            }

                            self.value.last_heartbeat =
                                server.last_heartbeat =
                                statusObj.value.last_heartbeat;
                            callback(null, server);
                        });
                } else {
                    callback(null, server);
                }
            });
    }
};


ModelServer.updateServerPropertiesFromSysinfo = function (opts) {
    var server = opts.server;
    var sysinfo = opts.sysinfo;

    server.sysinfo = sysinfo;
    server.ram = parseInt(sysinfo['MiB of Memory'], 10);
    server.current_platform = sysinfo['Live Image'];
    server.headnode = sysinfo['Boot Parameters']['headnode'] === 'true';
    server.boot_platform = server.boot_platform || sysinfo['Live Image'];
    server.hostname = server.hostname || sysinfo['Hostname'];

    if (!server.agents ||
        server.agents && Array.isArray(server.agents) &&
        server.agents.length === 0)
    {
        server.agents = server.agents || sysinfo['SDC Agents'];
    }

    if (sysinfo['SDC Version'] === '7.0' &&
        !sysinfo.hasOwnProperty('Setup'))
    {
        if (sysinfo.hasOwnProperty('Zpool')) {
            server.setup = true;
        } else {
            server.setup = false;
        }
    } else if (sysinfo.hasOwnProperty('Setup')) {
        if (sysinfo['Setup'] === 'true' ||
            sysinfo['Setup'] === true)
        {
            server.setup = true;
        } else if (sysinfo['Setup'] === 'false' || sysinfo['Setup'] === false) {
            server.setup = false;
        }
    }

    return server;
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

                    if (boot_params.kernel_args.rabbitmq_dns) {
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
        server.datacenter = ModelServer.getConfig().datacenter_name;
        server.overprovision_ratio = 1.0;
        server.reservation_ratio = 0.15;
        server.reservoir = false;
        server.traits = {};
        server.rack_identifier = '';
        server.comments = '';
        server.uuid = self.uuid;
        server.reserved = false;
        server.vms = {};

        server.boot_platform = boot_params.platform;
        server.boot_params = boot_params.kernel_args || {};
        server.kernel_flags = boot_params.kernel_flags || {};

        server.default_console = boot_params.default_console || 'serial';
        server.serial = boot_params.serial || 'ttyb';
        server.created = (new Date()).toISOString();

        callback(null, server);
    });
};

/**
 * Create a server object in Moray. Use the sysinfo values if they are given in
 * the opts argument. If no sysinfo values are given, do a sysinfo lookup on
 * the server via Ur, and then create the server using those values.
 */

ModelServer.prototype.create = function (opts, callback) {
    var self = this;
    var server = {};

    self.log.info({ opts: opts }, 'server creation opts');

    async.waterfall([
        function (cb) {
            ModelServer.initialValues({}, function (err, s) {
                server = s;
                server.uuid = opts.sysinfo.UUID;
                server.created = opts.created;
                server.sysinfo = opts.sysinfo;
                server.ram = parseInt(opts.sysinfo['MiB of Memory'], 10);
                server.hostname = opts.sysinfo.Hostname;
                server.status = opts.status;
                server.headnode =
                    opts.sysinfo['Boot Parameters']['headnode'] === 'true';
                server.current_platform = opts.sysinfo['Live Image'];

                server.setup = opts.setup;
                server.last_boot = opts.last_boot;
                cb();
            });
        }
    ],
    function (error) {
        self.store(
            server,
            function (createError, createdServer) {
                if (createError) {
                    self.log.error(
                        createError,
                        'Error creating server in moray');
                    callback(createError);
                    return;
                }
                self.log.info('Stored server record in moray');
                callback(null, server);
            });
    });
};


/**
 * Create a server record in moray.
 */

ModelServer.prototype.store = function (server, callback) {
    var self = this;

    var uuid = server['uuid'];

    delete server.memory;

    ModelServer.getMoray().putObject(
        buckets.servers.name,
        uuid,
        server,
        function (error) {
            if (error) {
                self.log.error(error, 'Error adding server to moray');
                callback(error);
                return;
            }

            callback();
        });
};


/**
 * Modify a server record.
 */

ModelServer.prototype.modify = function (server, callback) {
    var self = this;

    self.value = self.value || {};
    self.value = clone(server, self.value);

    // Remove obsolete attributes
    delete self.value.serial_speed;
    delete self.value.images;

    self.log.trace({ server: self.value.uuid },
                   'Writing server %s to moray', self.value.uuid);

    ModelServer.getMoray().putObject(
        buckets.servers.name,
        self.uuid,
        self.value,
        function (error) {
            if (error) {
                self.logerror(error, 'modifying server');
            }
            callback(error);
        });
};



/**
 * This function is invoked whenever a heartbeat is received from a compute
 * node. It takes care of refreshing two timeouts:
 *
 *     1) the timeout responsible for changing status => running/unknown.
 *
 *     2) the timeout responsible for throttling incoming heartbeats to prevent
 *        overly taxing moray with heartbeats which are already out of date.
 *
 *
 * It is also is responsible for writing `last_heartbeat` to a server's
 * `cnapi_status` bucket in moray.
 *
 * The goal of this is to accept new heartbeats and if we receive a heartbeat
 * while another is being written out to moray for the same server, stage it,
 * and then write it out when the original heartbeat write operation returns,
 * or a timeout is exhausted.
 */

ModelServer.prototype.onHeartbeat = function () {
    var self = this;
    var uuid = self.uuid;

    ModelServer.getApp().refreshServerHeartbeatTimeout(self.uuid);

    if (!ModelServer.getApp().collectedGlobalSysinfo) {
        return;
    }

    if (!ModelServer.getMoray().connected) {
        self.log.warn(
            'cannot refresh server from heartbeat: cannot reach moray');
        return;
    }


    if (!ModelServer.heartbeatByServerUuid) {
        ModelServer.heartbeatByServerUuid = {};
    }

    if (!ModelServer.heartbeatByServerUuid[uuid]) {
        ModelServer.heartbeatByServerUuid[uuid] = {};
    }

    var heartbeat = {
        server_uuid: uuid,
        last_heartbeat: (new Date()).toISOString()
    };

    // Check if we are still processing a heartbeat for this server: When we
    // begin processing a heartbeat we check if this value is set. If it is, we
    // override the `next` value and return. In this way we avoid having
    // multiple concurrent writes to moray for single server.

    if (ModelServer.heartbeatByServerUuid[uuid].current) {
        ModelServer.heartbeatByServerUuid[uuid].next = heartbeat;
        self.log.warn('already writing heartbeat from %s @ %s', uuid,
        ModelServer.heartbeatByServerUuid[uuid].current.last_heartbeat);

        if (ModelServer.heartbeatByServerUuid[uuid].timeout) {
            clearTimeout(ModelServer.heartbeatByServerUuid[uuid].timeout);
            writeNext();
        } else {
            resetTimeout();
        }

        return;
    } else {
        ModelServer.heartbeatByServerUuid[uuid] = {
            current: heartbeat
        };
    }

    // Set a timeout to clear the `current` value. If it is not set, we set a
    // timeout to clear it. The reason for the timeout is do not end up stuck
    // in this state (and end up ignoring future heartbeats).
    resetTimeout();

    doPut();

    function doPut() {
        ModelServer.getMoray().putObject(
            buckets.status.name,
            self.uuid,
            heartbeat,
            function (error) {
                if (error) {
                    self.log.error(error, 'modifying server last_heartbeat');
                }

                // If `.next` is set for this server once we've written the
                // value to moray, it means we have a new heartbeat staged for
                // writing into moray. If not set, do nothing, wait for next
                // heartbeat to come in as usual.
                if (ModelServer.heartbeatByServerUuid[uuid].next) {
                    writeNext();
                    return;
                } else {
                    clearTimeout(
                        ModelServer.heartbeatByServerUuid[uuid].timeout);
                    ModelServer.heartbeatByServerUuid[uuid] = {};
                }
            });
    }


    return;

    function resetTimeout() {
        clearTimeout(ModelServer.heartbeatByServerUuid[uuid].timeout);
        ModelServer.heartbeatByServerUuid[uuid].timeout =
            setTimeout(function () {
                self.log.warn('firing heartbeatByServer timeout for %s');
                // write the "next" heartbeat
                writeNext();
            }, common.HEARTBEATER_PERIOD * 2 * 1000);
    }

    function writeNext() {
        if (!ModelServer.heartbeatByServerUuid[uuid].next) {
            self.log.warn('onHeartbeat/writeNext called but .next not set');
            return;
        }

        var nextHb = ModelServer.heartbeatByServerUuid[uuid].next;
        delete ModelServer.heartbeatByServerUuid[uuid].next;
        ModelServer.heartbeatByServerUuid[uuid].current = nextHb;
        doPut();
    }
};


/**
 * Fetch from moray the stored `last_heartbeat` value for a given compute node.
 */

ModelServer.prototype.getLastHeartbeat =
function Server$getLastHeartbeat(callback) {
    var self = this;
    var uuid = this.uuid;

    ModelServer.getMoray().getObject(
        buckets.status.name,
        uuid,
        onGetObject);

    function onGetObject(error, obj) {
        if (error && VError.hasCauseWithName(error, 'ObjectNotFoundError')) {
            self.log.error(
                'last_heartbeat for %s not found in moray', uuid);
            callback();
            return;
        } else if (error) {
            self.log.error(
                error, 'error fetching last_heartbeat from moray');
            callback(error);
            return;
        }

        callback(null, obj.value.last_heartbeat);
    }
};


/**
 * This is called when we have determined that the sime since last heartbeat
 * for a given compute has exceeded the threshold for us to consider it
 * reachable.
 */
ModelServer.prototype.onHeartbeatTimeoutExpired = function () {
    var self = this;

    self.log.warn('server %s heartbeat timeout', self.uuid);

    var uuid = self.uuid;
    var lasthb;
    var server, serverobj;

    clearTimeout(ModelServer.getApp().statusTimeouts[uuid]);
    ModelServer.getApp().statusTimeouts[uuid] = null;

    // Get server
    // Get last_heartbeat
    // modify server status if last_heartbeat is not within range

    async.waterfall([
        getLastHeartbeat,
        getServer,
        function (next) {
            if (!serverobj) {
                self.log.info(
                    { uuid: uuid },
                    'could not find server');
                return next();
            }
            var now = Date.now();
            var then = new Date(lasthb).valueOf();
            var timeout = common.HEARTBEATER_PERIOD;

            if ((now - then) > timeout * 2 * 1000) {
                server.modify({ status: 'unknown' }, function (err) {
                    if (err) {
                        self.log.error(err);
                    }
                    self.log.warn(
                        { uuid: uuid },
                        'no heartbeat from server in %d ' +
                        'seconds, status => unknown',
                        common.HEARTBEATER_PERIOD);
                });
            } else {
                // It we got here it me means we didn't receive a heartbeat
                // from that server before our timeout, but when we checked
                // the server the last_heartbeat timestamp appears to have
                // been updated by another cnapi instance. Everything is
                // okay.
                self.log.info(
                    { uuid: uuid },
                    'no heartbeat from server but last_heartbeat looks ' +
                    'ok (now=%d then=%d d=%d)',
                    now, then, now-then);
            }
        }
    ],
    function (err) {
        if (err) {
            self.log.error(err,
                'writing status after server heartbeat timeout exceeeded');
        }
    });

    function getLastHeartbeat(next) {
        self.getLastHeartbeat(function (err, hb) {
            if (err) {
                return next(err);
            }
            lasthb = hb;
            next();
        });
    }

    function getServer(next) {
        ModelServer.get(uuid, function (err, s, so) {
            if (err) {
                self.log.error(
                    err,
                    'error looking up server with expired heartbeat timer');
            }
            server = s;
            serverobj = so;
            next();
        });
    }
};



function clone(obj, dest) {
    var target = dest ? dest : ((obj instanceof Array) ? [] : {});
    for (var i in obj) {
        if (obj[i] && typeof (obj[i]) == 'object') {
            target[i] = clone(obj[i]);
        } else {
            target[i] = obj[i];
        }
    }
    return target;
}


ModelServer.get = function (uuid, callback) {
    var server = new ModelServer(uuid);
    server.getRaw({
        vms: true, memory: true,
        disk: true, status: true,
        sysinfo: true, last_heartbeat: true,
        agents: true
    }, function (err, serverobj) {
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
    this.value = clone(raw);
};


/**
 * Filter the server attributes based on fields passed in.
 */

ModelServer.prototype.getFinal = function (/* extras, */ callback) {
    var self = this;

    var extrasDefaults = {
        vms: false, memory: false,
        disk: false, status: true,
        sysinfo: false, last_heartbeat: false,
        agents: false
    };

    var extras = extrasDefaults;

    if (arguments.length === 2) {
        extras = arguments[0];
        callback = arguments[1];

        if (extras.all) {
            extras = {
                vms: true, memory: true,
                disk: true, sysinfo: true,
                status: true, last_heartbeat: true,
                agents: true
            };
        } else {
            for (var extraKey in extrasDefaults) {
                if (!extras.hasOwnProperty(extraKey)) {
                    extras[extraKey] = extrasDefaults[extraKey];
                }
            }
        }
    }

    var server;

    async.waterfall([
        function (cb) {
            self.getRaw(extras, function (getError, s) {
                if (getError) {
                    cb(getError);
                    return;
                }
                cb();
            });
        },
        function (cb) {
            self.filterFields(extras, function (filterError, s) {
                server = s;
                cb(filterError);
            });
        },
        function (cb) {
            if (server.overprovision_ratios) {
                var v = qs.parse(server.overprovision_ratios);

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
            if (server.status === 'unknown' && server.transitional_status) {
                server.status = server.transitional_status;
                delete server.transitional_status;
            }
            cb();
        }
    ],
    function (error) {
        callback(error, server);
    });
};



/**
 * Compare the VMs given in a heartbeat with those stored in moray for a
 * particular server.
 */
ModelServer.carryForwardVMChanges =
function (heartbeat, serverobj) {
    var self = this;

    var vms = {};
    var vmuuid;

    if (!serverobj.vms) {
        self.log.warn('server vms member empty');
        serverobj.vms = {};
    }

    if (!heartbeat.vms) {
        self.log.warn({ server: this.uuid }, 'heartbeat vms member empty');
        serverobj.vms = {};
        return;
    }

    for (vmuuid in heartbeat.vms) {
        if (!serverobj.vms[vmuuid]) {
            self.log.trace({ vm_uuid: vmuuid },
                           'heartbeat shows vm changed (now exists)');
        }

        vms[vmuuid] = heartbeat.vms[vmuuid];

        if (serverobj.vms[vmuuid] &&
            serverobj.vms[vmuuid].last_modified !==
            heartbeat.vms[vmuuid].last_modified)
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

    self.getRaw(function (geterror, raw) {
        wfParams = {
            // Set nic action to update, so that we add the nic tags
            // rather than replace or delete
            nic_action: 'update',
            amqp_host: ModelServer.getConfig().amqp.host,
            cnapi_url: ModelServer.getConfig().cnapi.url,
            assets_url: ModelServer.getConfig().assets.url,
            server_uuid: uuid,
            target: uuid,
            overprovision_ratio: raw.overprovision_ratio
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

        // Caching is the default, we only need to pass in disk cache
        // when it's false:
        if (params.hasOwnProperty('disk_cache') &&
            params.disk_cache === false) {
            wfParams.disk_cache = params.disk_cache;
        }

        if (params.hasOwnProperty('disk_layout') && params.disk_layout) {
            wfParams.disk_layout = params.disk_layout;
        }

        async.waterfall([
            function (cb) {
                if (params.hasOwnProperty('hostname') && params.hostname) {
                    raw.hostname = params.hostname;
                    self.modify(raw, function (modifyError) {
                        cb(modifyError);
                    });
                } else {
                    cb();
                }
            }, function (cb) {
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
        ], function (err) {
            callback(err, job_uuid);
        });
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
 * Set the boot parameters on a server object.
 */

ModelServer.prototype.setBootParams = function (bootParams, callback) {
    var self = this;

    self.getRaw(function (error, server) {
        if (error) {
            self.logerror('server to be modified did not exist');
            callback(error);
            return;
        }

        server.default_console = bootParams.default_console;
        server.serial = bootParams.serial;

        server.boot_params = bootParams.boot_params;
        server.boot_platform = bootParams.boot_platform;
        server.kernel_flags = bootParams.kernel_flags || {};
        server.boot_modules = bootParams.boot_modules || [];

        self.modify(server, function (modifyError) {
            callback(modifyError);
            return;
        });
    });
};



ModelServer.prototype.updateBootParams = function (bootParams, callback) {
    var self = this;

    self.getRaw(function (error, server) {
        if (error) {
            self.logerror('server to be modified did not exist');
            callback(error);
            return;
        }

        if (bootParams.boot_platform) {
            server.boot_platform = bootParams.boot_platform;
        }

        if (bootParams.boot_modules) {
            server.boot_modules = bootParams.boot_modules;
        }

        var k;
        if (bootParams.boot_params) {
            if (!server.boot_params) {
                server.boot_params = {};
            }
            for (k in bootParams.boot_params) {
                if (bootParams.boot_params[k] === null) {
                    delete server.boot_params[k];
                    continue;
                }
                server.boot_params[k] = bootParams.boot_params[k];
            }
        }

        if (bootParams.kernel_flags) {
            if (!server.kernel_flags) {
                server.kernel_flags = {};
            }
            for (k in bootParams.kernel_flags) {
                if (bootParams.kernel_flags[k] === null) {
                    delete server.kernel_flags[k];
                    continue;
                }
                server.kernel_flags[k] = bootParams.kernel_flags[k];
            }
        }

        var names = ['default_console', 'serial'];

        names.forEach(function (n) {
            if (bootParams[n] === null) {
                server[n] = '';
                return;
            }
            server[n] = bootParams[n] || server[n];
        });

        self.modify(server, function (modifyError) {
            if (error) {
                callback(new VError(modifyError,
                                    'modifying server boot param'));
                return;
            }
            callback();
            return;
        });
    });
};

/**
 * Returns a function which acts as a handler for cn-agent tasks.
 *
 * createTaskHandler takes three arguments:
 * - self: a reference to an instance of Model
 * - eventCallback: which will be called whenever an event is received from
 *   the running task. It gets as arguments the task id and the event object.
 * - callback: the function to be called when the returned function sets up
 *   the task handle handler.
 */

ModelServer.createTaskHandler =
function (self, params, handlerOpts, eventCallback, callback, synccb) {
    var persist = handlerOpts.persist !== false ? true : false;

    var taskqueue = async.queue(function (qobj, cb) {
        var task = qobj;
        if (!persist) {
            checkFinished();
            cb();
            return;
        }

        var moray = ModelServer.getMoray();
        moray.putObject(
            buckets.tasks.name,
            task.id,
            task,
            function (putError) {
                if (putError) {
                    self.log.error({
                        err: putError,
                        task_id: task.id
                    }, 'error doing putObject');
                }

                checkFinished();
                cb();
            });


        function checkFinished() {
            var lastHist = task.history[task.history.length-1];

            if (['complete', 'failure'].indexOf(task.status)
                     !== -1)
            {
                var error;
                if (lastHist &&
                    lastHist.event.msg &&
                    lastHist.event.msg.error)
                {
                    error = lastHist.event.msg.error;
                }

                ModelServer.getApp().alertWaitingTasks(
                    error && new Error(error), task.id, task);

                if (synccb) {
                    synccb(null, error ? error: lastHist.event);
                }

            } else {
                // On the first push to async.queue, history won't have
                // anything in it so do not try to pull anything out of it.
                if (task.history.length) {
                    var event = lastHist.event;
                    eventCallback(task, event);
                }
            }
        }
    }, 1);

    if (synccb) {
        synccb = once(synccb);
    }

    return function (taskHandle) {
        var task = {};
        self.log.info('Task id = %s', taskHandle.id);
        task.id = taskHandle.id;
        task.task = params.task;
        task.progress = 0;
        task.server_uuid = self.uuid;
        task.status = 'active';
        task.history = [];
        task.timestamp = (new Date()).toISOString();

        if (persist) {
            var moray = ModelServer.getMoray();
            moray.putObject(buckets.tasks.name, taskHandle.id, task,
                function (putError) {
                    if (putError) {
                        self.log.error({ err: putError },
                            'writing initial task details to moray');
                            return;
                    }
                    taskqueue.push(JSON.parse(JSON.stringify(task)));
                    callback(null, taskHandle);
                });
        } else {
            taskqueue.push(JSON.parse(JSON.stringify(task)));
            callback(null, taskHandle);
        }


        taskHandle.on('event', function (eventName, msg) {
            var event = {
                name: eventName,
                event: msg
            };
            self.log.debug(event, 'Event details');
            if (!event.timestamp) {
                event.timestamp = (new Date()).toISOString();
            }
            task.history.push(event);

            switch (eventName) {
                case 'progress':
                    task.progress = msg.value;
                break;
                case 'error':
                    if (task.status === 'active') {
                        task.status = 'failure';
                        taskqueue.push(JSON.parse(JSON.stringify(task)));
                    }
                break;
                case 'finish':
                    if (task.status === 'active') {
                        task.status = 'complete';
                        taskqueue.push(JSON.parse(JSON.stringify(task)));
                    }
                break;
                default:
                    break;
            }

        });
    };
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

    assert.string(opts.task, 'opts.task');
    assert.object(opts.params, 'opts.params');
    assert.optionalObject(opts.req, 'opts.req');
    assert.optionalBool(opts.persist, 'opts.persist');
    assert.func(opts.cb, 'opts.cb');
    assert.optionalFunc(opts.cb, 'opts.cb');

    var task, params, callback, origreq, persist;
    var synccb;
    var serverAdminIp;
    var client;
    var req_id;

    if (opts.req_id) {
        req_id = opts.req_id;
    } else if (opts.req) {
        req_id = opts.req.getId();
    }

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
    origreq = opts.req;
    callback = opts.cb;
    synccb = opts.synccb;
    var log = origreq && origreq.log || self.log;

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
        function (wfcb) {
            self.getRaw(function (err, server) {
                if (err) {
                    wfcb(new VError(err, err));
                   return;
                }

                if (!server) {
                    wfcb(new VError('server not found'));
                   return;
                }

                try {
                    serverAdminIp = firstAdminIp(server.sysinfo);
                } catch (e) {
                    wfcb(new VError(e, 'parsing server ip address'));
                    return;
                }

                log.info('sysinfo for %s before task %s', self.uuid, task);
                wfcb();
            });
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
                url: 'http://' + serverAdminIp + ':' + 5309,
                requestTimeout: 3600 * 1000,
                connectTimeout: 3600 * 1000
            };
            var rOpts = { path: '/tasks' };

            rOpts.headers = {
                'x-server-uuid': self.uuid,
                'x-request-id': req_id
            };

            client = restify.createJsonClient(cOpts);

            log.info('posting task to %s%s (req_id=%s)',
                     cOpts.url, rOpts.path, req_id);

            // write initial task to moray
            // post http request
            // on response from post, write to moray again
            // call evcb();

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


                log.info({ obj: obj }, 'post came back with');

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

    var method = opts.method.toLowerCase();
    var params = opts.params || {};
    var serverAdminIp;
    var client;

    var log = self.log;

    async.waterfall([
        function getAdminIpFromSysinfo(wfcb) {
            self.getRaw(function (err, server) {
                if (err) {
                    wfcb(new VError(err, err));
                   return;
                }

                if (!server) {
                    wfcb(new VError('server not found'));
                   return;
                }

                try {
                    serverAdminIp = firstAdminIp(server.sysinfo);
                } catch (e) {
                    wfcb(new VError(e, 'parsing server ip address'));
                    return;
                }

                log.info('sysinfo for %s before HTTP request', self.uuid);
                wfcb();
            });
        },
        function executeRequest(wfcb) {
            var cOpts = {
                url: 'http://' + serverAdminIp + ':' + 5309,
                requestTimeout: 3600 * 1000,
                connectTimeout: 3600 * 1000
            };
            var rOpts = { path: opts.path };

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
        evcb: function () {},
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


function firstAdminIp(sysinfo) {
    var interfaces;
    var addr;

    // first see if we have an override in the sysinfo
    addr = sysinfo['Admin IP'];
    if (addr) {
        return addr;
    }

    interfaces = sysinfo['Network Interfaces'];

    for (var iface in interfaces) {
        if (!interfaces.hasOwnProperty(iface)) {
            continue;
        }

        var nic = interfaces[iface]['NIC Names'];
        var isAdmin = nic.indexOf('admin') !== -1;
        if (isAdmin) {
            addr = interfaces[iface]['ip4addr'];
            return addr;
        }
    }

    throw new Error('No NICs with name "admin" detected.');
}


module.exports = ModelServer;
