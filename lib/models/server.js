/*
 *
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This file contains all the Compute Server logic, used to interface with the
 * server as well as it's stored representation in the backend datastores.
 */

var async = require('async');
var dns = require('dns');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var verror = require('verror');
var qs = require('querystring');

var buckets = require('../apis/moray').BUCKETS;
var common = require('../common');
var ModelBase = require('./base');
var ModelVM = require('./vm');
var ModelWaitlist = require('./waitlist');

var PROVISIONER = 'provisioner';

var MEMORY_USAGE_KEYS = [
    'memory_available_bytes',
    'memory_arc_bytes',
    'memory_total_bytes',
    'memory_provisionable_bytes'
];

var DISK_USAGE_KEYS = [
    'disk_kvm_zvol_used_bytes',
    'disk_kvm_zvol_volsize_bytes',
    'disk_kvm_quota_bytes',
    'disk_zone_quota_bytes',
    'disk_cores_quota_bytes',
    'disk_installed_images_used_bytes',
    'disk_pool_size_bytes'
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

    ModelServer.scache = {};
};


ModelServer.prototype.register = function () {
    this.log.info('Registering server %s (active)', this.uuid);
    this.cacheUpdateServer({ active: true });
};

ModelServer.prototype.unregister = function () {
    this.log.info('Unregistering server %s (inactive)', this.uuid);
    this.cacheUpdateServer({ active: false });
};

ModelServer.createProvisionerEventHandler = function (app, jobuuid) {
    var self = this;
    var workflow = ModelServer.getWorkflow();

    return function (taskid, event) {
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
    var self = this;

    var uuid = params.uuid;

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

    ['limit', 'offset'].forEach(function (f) {
        if (params.hasOwnProperty(f)) {
            findOpts[f] = params[f];
        }
    });

    var req = moray.findObjects(
        buckets.servers.name,
        filter,
        findOpts);

    var servers = [];

    req.on('error', onError);
    req.on('record', onRecord);
    req.on('end', processResults);

    function onError(error) {
        self.log.error(error, 'Error retriving results');
        callback(error);
    }

    function onRecord(server) {
        servers.push(server.value);
    }

    function processResults() {
        if (!wantFinal) {
            callback(null, servers);
            return;
        }

        async.map(
            servers,
            function (server, cb) {
                var serverModel = new ModelServer(server.uuid);
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

    var defaultServer = {
        uuid: 'default',
        boot_platform: 'latest',
        default_console: 'vga',
        serial: 'ttyb',
        boot_params: {},
        kernel_flags: {},
        boot_modules: []
    };

    if (arguments.length === 2) {
        defaultServer = {
            uuid: 'default'
        };
        for (var k in values) {
            defaultServer[k] = values[k];
        }
    } else {
        defaultServer = {
            uuid: 'default',
            boot_platform: 'latest',
            default_console: 'vga',
            serial: 'ttyb',
            boot_params: {},
            kernel_flags: {},
            boot_modules: []
        };
        callback = arguments[0];
    }

    var moray = ModelServer.getMoray();

    moray.putObject(
        buckets.servers.name,
        'default',
        defaultServer,
        function (putError) {
            if (putError) {
                self.log.error('Could not store default server');
                callback(
                    verror.VError(putError, 'failed to store default server'));
                return;
            }
            callback();
        });
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
                callback(new verror.VError(
                    error, 'failed to store default server'));
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
                        callback(verror.VError(
                            putError, 'failed to store default server'));
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
        }

        callback(err, stdout, stderr);
        return;
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
            creator_uuid: params.creator_uuid
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
 * Fetches and returns the server's cached values and merges them with the raw
 * internal values.
 */

ModelServer.prototype.applyCachedValues = function (fields, callback) {
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
                cb();
                return;
            }
            self.cacheGetLastHeartbeat(
                function (statusError, lastHeartbeat) {
                    if (statusError) {
                        self.logerror(
                            statusError,
                            'fetching server status');

                        cb(statusError);
                        return;
                    }

                    server.last_heartbeat = lastHeartbeat;
                    cb();
                });
        },
        function (cb) {
            if (skip('status', fields)) {
                cb();
                return;
            }
            self.cacheGetServerStatus(
                function (statusError, status) {
                    if (statusError) {
                        self.logerror(
                            statusError,
                            'fetching server status');

                        cb(statusError);
                        return;
                    }

                    if (server.setup) {
                        server.status = status || 'unknown';
                    } else {
                        server.status = status || 'unsetup';
                    }
                    self.log.debug(
                        'Status for %s was %s', self.uuid, server.status);
                    cb();
                });
        },
        function (cb) {
            if (skip('memory', fields)) {
                cb();
                return;
            }
            self.cacheGetMemoryUsage(
                function (cacheError, memory) {
                    if (cacheError) {
                        self.logerror(
                            cacheError,
                            'fetching memory values');

                        cb(cacheError);
                        return;
                    }

                    if (!memory) {
                        cb();
                        return;
                    }

                    for (var m in memory) {
                        server[m] = memory[m];
                    }

                    cb();
                });
        },
        function (cb) {
            if (skip('disk', fields)) {
                cb();
                return;
            }
            self.cacheGetDiskUsage(
                function (cacheError, disk) {
                    if (cacheError) {
                        self.logerror(
                            cacheError,
                            'fetching memory values');

                        cb(cacheError);
                        return;
                    }
                    if (!disk) {
                        cb();
                        return;
                    }

                    for (var m in disk) {
                        server[m] = disk[m];
                    }

                    cb();
                });
        },
        function (cb) {
            if (skip('vms', fields)) {
                delete server.vms;
                cb();
                return;
            }
            self.cacheGetVms(
                function (cacheError, vms) {
                    if (cacheError) {
                        self.logerror(cacheError, 'getting vms');
                        cb(cacheError);
                        return;
                    }

                    server.vms = {};
                    if (vms) {
                        Object.keys(vms).forEach(function (uuid) {
                            try {
                                server.vms[uuid] = vms[uuid];
                            } catch (e) {
                                self.log.error(e);
                                cb(e);
                                return;
                            }
                        });
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
        callback(null, server);
    });
};


/**
 * Update the a servers cache values from an incoming heartbeat message.
 */

ModelServer.prototype.updateCacheFromHeartbeat =
function (heartbeat, override, callback) {
    var self = this;

    async.waterfall([
        // Update the server's zones cache
        updateCacheZones,

        // Update the server's memory cache
        updateCacheMemory,

        // Update the server's disk cache
        updateCacheDisk,

        // Update the server's memory cache
        updateCacheStatus,

        // Update last heartbeat value
        updateLastHeartbeat
    ],
    function (error) {
        callback(error);
    });

    function updateCacheZones(cb) {
        var vms = {};

        if (heartbeat.hasOwnProperty('vms')) {
            Object.keys(heartbeat.vms).forEach(function (uuid) {
                vms[uuid] = heartbeat.vms[uuid];
            });
        }

        if (override.hasOwnProperty('vms')) {
            Object.keys(override.vms).forEach(function (uuid) {
                vms[uuid] = override.vms[uuid];
            });
        }

        self.cacheSetVms(vms, function (error) {
            if (error) {
                self.log.error('Could not update VMs cache on heartbeat');
                cb(error);
                return;
            }
            cb();
        });
    }

    function updateCacheMemory(cb) {
        if (!heartbeat.hasOwnProperty('meminfo')) {
            cb();
            return;
        }

        self.updateMemoryFromHeartbeat(heartbeat, function () {
            cb();
        });
    }

    function updateCacheDisk(cb) {
        if (!heartbeat.hasOwnProperty('diskinfo')) {
            cb();
            return;
        }

        self.updateDiskFromHeartbeat(heartbeat, function () {
            cb();
        });
    }

    function updateCacheStatus(cb) {
        self.cacheSetServerStatus(
            'running',
            function (error) {
                if (error) {
                    self.log.error(
                        error,
                        'Error setting server (%s) status', self.uuid);
                }
                cb();
            });
    }

    function updateLastHeartbeat(cb) {
        self.updateLastHeartbeat(function () {
            cb();
        });
    }
};


/**
 * Cache server memory usage values.
 */

ModelServer.prototype.updateMemoryFromHeartbeat =
function (heartbeat, callback) {
    var self = this;
    var memoryKeys = [
        ['availrmem_bytes', 'memory_available_bytes'],
        ['arcsize_bytes', 'memory_arc_bytes'],
        ['total_bytes', 'memory_total_bytes'] ];

    var memory = {};

    memoryKeys.forEach(function (keys) {
        memory[keys[1]] = heartbeat.meminfo[keys[0]];
    });

    /**
     * Compute the memory_provisionable_bytes value based on the total memory,
     * the reservation ratio and the max_physical_memory values of all vms.
     */

    self.cacheGetServer(function (error, cacheServer) {
        var reservation_ratio = cacheServer.reservation_ratio;
        var total_memory_bytes
            = cacheServer.sysinfo['MiB of Memory'] * 1024 * 1024;

        memory.memory_provisionable_bytes =
            total_memory_bytes - (total_memory_bytes * reservation_ratio);

        memory.memory_provisionable_bytes -= 1024 * 1024 *
            Object.keys(heartbeat.vms)
                .map(function (uuid) {
                    return heartbeat.vms[uuid];
                })
                .reduce(function (prev, curr) {
                    return prev + curr.max_physical_memory;
                }, 0);

        memory.memory_provisionable_bytes =
            Math.floor(memory.memory_provisionable_bytes);

        var serverModel = new ModelServer(self.uuid);
        serverModel.cacheSetMemoryUsage(memory, callback);
    });
};


/**
 * Cache server disk usage values.
 */

ModelServer.prototype.updateDiskFromHeartbeat =
function (heartbeat, callback) {
    var diskKeys = [
        ['kvm_zvol_used_bytes', 'disk_kvm_zvol_used_bytes'],
        ['kvm_zvol_volsize_bytes', 'disk_kvm_zvol_volsize_bytes'],
        ['kvm_quota_bytes', 'disk_kvm_quota_bytes'],
        ['zone_quota_bytes', 'disk_zone_quota_bytes'],
        ['cores_quota_bytes', 'disk_cores_quota_bytes'],
        ['installed_images_used_bytes', 'disk_installed_images_used_bytes'],
        ['pool_size_bytes', 'disk_pool_size_bytes']
    ];

    var disk = {};

    diskKeys.forEach(function (keys) {
        disk[keys[1]] = heartbeat.diskinfo[keys[0]];
    });

    var serverModel = new ModelServer(this.uuid);
    serverModel.cacheSetDiskUsage(disk, callback);
};


ModelServer.prototype.updateLastHeartbeat =
function (callback) {
    this.cacheSetLastHeartbeat((new Date()).toISOString(), callback);
};


/**
 * Returns a copy of the server model's internal representation retried from
 * the backend store, or from memory if this object has been previously
 * fetched.
 */

ModelServer.prototype.getRaw = function (callback) {
    var self = this;
    var uuid = self.uuid;
    var server;

    if (self.exists === false) {
        this.log.debug(
            '%s was not found previously, returning negative result', uuid);
        server = clone(self.value);
        callback(null, server);
    }

    if (self.value) {
        this.log.debug('Reusing raw value for %s', uuid);
        server = clone(self.value);
        callback(null, server);
    } else {
        this.log.trace('Fetching server %s from moray', uuid);
        ModelServer.getMoray().getObject(
            buckets.servers.name,
            uuid,
            function (error, obj) {
                if (error && error.name === 'ObjectNotFoundError') {
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

                /* Cache certain highly-used values */

                self.cacheUpdateServer({
                    reservation_ratio: server.reservation_ratio,
                    setup: server.setup
                });

                server = clone(self.value);
                callback(null, server);
            });
    }
};


ModelServer.updateServerPropertiesFromSysinfo = function (opts) {
    var server = opts.server;
    var sysinfo = opts.sysinfo;

    server.sysinfo = opts.sysinfo;
    server.ram = Number(sysinfo['MiB of Memory']);
    server.current_platform = sysinfo['Live Image'];
    server.headnode = sysinfo['Boot Parameters']['headnode'] === 'true';
    server.boot_platform = server.boot_platform || sysinfo['Live Image'];
};


/**
 * Create a server object suitable for insertion into Moray from a sysinfo
 * object or heartbeat.
 */

ModelServer.prototype.initialServerValues = function (opts) {
    var server = {};
    var sysinfo = opts.sysinfo;

    ModelServer.updateServerPropertiesFromSysinfo({
        sysinfo: sysinfo,
        server: server
    });

    server.datacenter = ModelServer.getConfig().datacenter_name;
    server.overprovision_ratio = 1.0;
    server.reservation_ratio = 0.15;
    server.reservoir = false;
    server.traits = {};
    server.rack_identifier = '';
    server.comments = '';
    server.uuid = sysinfo.UUID;
    server.hostname = sysinfo.Hostname;
    server.reserved = false;

    server.boot_params = opts.boot_params.kernel_args || {};
    server.kernel_flags = opts.boot_params.kernel_flags || {};

    server.default_console = opts.boot_params.default_console || 'vga';
    server.serial = opts.boot_params.serial || 'ttyb';

    if (opts.setup) {
        server.setup = true;
    } else if (sysinfo['SDC Version'] === '7.0' &&
               !sysinfo.hasOwnProperty('Setup'))
    {
        if (sysinfo.hasOwnProperty('Zpool')) {
            server.setup = true;
        } else {
            server.setup = false;
        }
    } else if (sysinfo.hasOwnProperty('Setup')) {
        if (sysinfo['Setup'] === 'true' || sysinfo['Setup'] === true) {
            server.setup = true;
        } else if (sysinfo['Setup'] === 'false' || sysinfo['Setup'] === false) {
            server.setup = false;
        }
    }

    server.setting_up = false;

    if (opts.last_boot) {
        server.last_boot = opts.last_boot;
    }

    return server;
};


/**
 * Create a server object in Moray. Use the sysinfo values if they are given in
 * the opts argument. If no sysinfo values are given, do a sysinfo lookup on
 * the server via Ur, and then create the server using those values.
 */

ModelServer.prototype.create = function (opts, callback) {
    var self = this;
    var uuid = this.uuid;
    var sysinfo;
    var server;
    var boot_params;

    async.waterfall([
        function (cb) {
            if (opts.sysinfo) {
                sysinfo = opts.sysinfo;
                cb();
            } else {
                self.log.info('Querying Ur agent for server sysinfo');
                ModelServer.getUr().serverSysinfo(
                    uuid,
                    function (error, returnedSysinfo) {
                    sysinfo = returnedSysinfo;
                    cb();
                });
            }
        },
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
        server = self.initialServerValues({
            boot_params: boot_params,
            sysinfo: sysinfo,
            last_boot: opts.last_boot,
            setup: opts.setup
        });

        server.created = opts.created;

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

                self.cacheSetServerStatus(
                    server.status,
                    function (statusError) {
                        if (statusError) {
                            self.log.error(
                                'Error setting server status for %s',
                                self.uuid);
                        }
                        callback(statusError, server);
                    });
            });
    });
};


/**
 * Create a server record in moray.
 */

ModelServer.prototype.store = function (server, callback) {
    var self = this;

    var uuid = server['uuid'];
    var memory = server.memory;

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

            self.cacheUpdateServer({
                reservation_ratio: server.reservation_ratio,
                setup: server.setup
            });

            if (memory) {
                self.cacheSetMemoryUsage(memory, callback);
            } else {
                callback();
            }
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
    delete self.value.last_heartbeat;

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


/**
 * Delete all references to a server.
 */

ModelServer.prototype.del = function (callback) {
    var self = this;
    async.parallel([
        function (cb) {
            self.log.info('Deleting server %s from moray', self.uuid);
            ModelServer.getMoray().delObject(
                buckets.servers.name,
                self.uuid,
                function (error) {
                    cb(error);
                });
        },
        function (cb) {
            self.cacheDeleteServerAll(
                function (error) {
                    cb(error);
                });
        }
    ],
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
 * Return this server's values with cached values applied.
 */

ModelServer.prototype.getFinal = function (callback) {
    var self = this;

    var extras = {
        vms: true, memory: true,
        disk: true, status: true,
        sysinfo: true, last_heartbeat: true };

    if (arguments.length === 2) {
        extras = arguments[0];
        callback = arguments[1];

        if (extras.all) {
            extras = {
                vms: true, memory: true,
                disk: true, sysinfo: true,
                status: true, last_heartbeat: true };
        }
    }

    var server;

    async.waterfall([
        function (cb) {
            self.getRaw(function (getError, s) {
                if (!s) {
                    process.nextTick(function () {
                        try {
                            callback();
                        }
                        catch (e) {
                            self.log.error(e, 'Error raised: ');
                            callback(e);
                        }
                    });
                    return;
                }

                cb();
            });
        },
        function (cb) {
            self.applyCachedValues(extras, function (cacheError, s) {
                server = s;
                cb(cacheError);
            });
        },
        function (cb) {
            if (server.overprovision_ratios) {
                server.overprovision_ratios =
                    qs.parse(server.overprovision_ratios);
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
        process.nextTick(function () {
            try {
                callback(null, server);
            }
            catch (e) {
                self.log.error(e, 'Error raised: ');
                callback(e);
            }
        });
    });
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
                callback(
                    new verror.VError(getError, 'getting default object'));
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
                callback(new verror.VError(
                    modifyError, 'modifying server boot param'));
                return;
            }
            callback();
            return;
        });
    });
};

/**
 * Returns a function which acts as a handler for provisioner tasks.
 *
 * createTaskHandler takes three arguments:
 * - self: a reference to an instance of Model
 * - eventCallback: which will be called whenever an event is received from
 *   the running task. It gets as arguments the task id and the event object.
 * - callback: the function to be called when the returned function sets up
 *   the task handle handler.
 */

ModelServer.createTaskHandler = function (self, eventCallback, callback) {
    var taskqueue = async.queue(function (qobj, cb) {
        var moray = ModelServer.getMoray();
        moray.putObject(
            buckets.tasks.name,
            qobj.id,
            qobj,
            function (putError) {
                if (putError) {
                    self.log.error({
                        err: putError,
                        task_id: qobj.id
                    }, 'error doing putObject');
                    cb();
                    return;
                }
                cb();
            });
    }, 1);

    return function (taskHandle) {
        var task = {};
        self.log.info('Task id = %s', taskHandle.id);
        process.nextTick(function () {
            callback(null, taskHandle.id);
        });
        task.id = taskHandle.id;
        task.progress = 0;
        task.server_uuid = self.uuid;
        task.status = 'active';
        task.history = [];
        task.timestamp = (new Date()).toISOString();

        taskqueue.push(task);

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
                    task.status = 'failure';
                    break;
                case 'finish':
                    if (task.status === 'active') {
                        task.status = 'complete';
                    }
                    break;
                default:
                    break;
            }

            taskqueue.push(task);

            eventCallback(task.id, event);
        });
    };
};


/*
 * Initiates a provisioner task.
 */
ModelServer.prototype.sendProvisionerTask =
function () {
    var self = this;

    var opts, task, params, evcb, cb, req;

    switch (arguments.length) {
        case 1:
            opts = arguments[0];
            task = opts.task;
            params = opts.params;
            evcb = opts.evcb;
            cb = opts.cb;
            req = opts.req;
            break;

        case 4:
            task = arguments[0];
            params = arguments[1];
            evcb = arguments[2];
            cb = arguments[3];
            break;

        default:
            throw new verror.VError('Invalid number of arguments');
    }


    self.log.debug({server: self.uuid, task: task, params: params},
        'sendProvisionerTask');

    params = JSON.parse(JSON.stringify(params));
    params.req_id = req.getId();
    ModelServer.getTaskClient().getAgentHandle(
        PROVISIONER,
        self.uuid,
        function (handle) {
            handle.sendTask(
                task,
                params,
                ModelServer.createTaskHandler(self, evcb, cb));
        });
};


ModelServer.prototype.zfsTask = function (task, options, callback) {
    var self = this;

    var uuid = self.uuid;

    self.log.info(options);

    ModelServer.getTaskClient().getAgentHandle(
        PROVISIONER,
        uuid,
        function (handle) {
            handle.sendTask(task, options,
            onSendTask);
        });

    function onSendTask(taskHandle) {
        var error;

        taskHandle.on('event', function (eventName, msg) {
            if (eventName === 'error') {
                self.log.error(
                    'Error received during zfs task: %s',
                    msg.error);
                error = msg.error;
                return;
            } else if (eventName === 'finish') {
                if (error) {
                    callback(new Error(error));
                    return;
                } else {
                    callback(null, msg);
                    return;
                }
            }
        });
    }
};


/**
 * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 *
 * Cache-related functionality.
 *
 * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */


/**
 * Insert a Server record into cache.
 */

ModelServer.prototype.cacheSetServer =
function (sysinfo, callback) {
    var self = this;
    self.cacheUpdateServer({
        uuid: self.uuid }, callback);
};


/**
 * Fetch a Server record from cache.
 */

ModelServer.prototype.cacheGetServer =
function () {
    var self = this;
    var callback, opts = {};

    switch (arguments.length) {
        case 1:
            callback = arguments[0];
            break;
        case 2:
            opts = arguments[0];
            callback = arguments[1];
            break;
        default:
            throw new Error('Invalid arguments');
    }

    var server = ModelServer.scache[self.uuid];

    if (opts.assertServer && !server) {
        callback(new Error('Server ' + self.uuid + ' not found'));
        return;
    }

    callback(null, server);
};


/**
 * Test the server cache for the existence of a particular server.
 */

ModelServer.prototype.cacheCheckServerExists =
function (callback) {
    var self = this;
    self.cacheGetServer(
        { assertServer: false },
        function (error, server) {
            if (error) {
                callback(error);
                return;
            }
            callback(null, !!server);
        });
};


/**
 * Update values within a cached server record (or create the record if it does
 * not yet exist)
 */

ModelServer.prototype.cacheUpdateServer = function (values, callback) {
    var self = this;
    values = JSON.parse(JSON.stringify(values));
    values.last_modified = (new Date()).toISOString();

    var s = ModelServer.scache[self.uuid] || {};

    for (var val in values) {
        s[val] = values[val];
    }

    ModelServer.scache[self.uuid] =
        JSON.parse(JSON.stringify(s));

    if (callback) {
        callback();
    }
};

/**
 * Set the cached server status particular server.
 */

ModelServer.prototype.cacheSetServerStatus =
function (status, callback) {
    var self = this;

    self.cacheUpdateServer({
        status: status, status_timestamp: (new Date()).toISOString() },
        callback);
};

/**
 * Set the cached server sysinfo for particular server.
 */

ModelServer.prototype.cacheSetServerSysinfo =
function (sysinfo, callback) {
    var self = this;

    self.cacheUpdateServer({ sysinfo: sysinfo }, callback);
};


/**
 * Fetch the cached server status particular server.
 */

ModelServer.prototype.cacheGetServerStatus =
function (callback) {
    var self = this;
    self.cacheGetServer(
        { assertServer: false },
        function (error, server) {
            if (error) {
                callback(error);
                return;
            }

            if (!server) {
                callback(null, 'unknown');
                return;
            }

            var delta = new Date() - new Date(server.status_timestamp);
            var status = 'unknown';

            if (server.setup) {
                if (delta <= 10000) {
                    status = 'running';
                }
            } else {
                if (delta <= 70000) {
                    status = 'running';
                }
            }

            callback(null, status);
        });
};


/**
 * Update the memory usage cache for a particular server.
 */

ModelServer.prototype.cacheSetMemoryUsage =
function (memory, callback) {
    var self = this;
    self.cacheUpdateServer(memory, callback);
};


/**
 * Fetch a server's cached disk usage information.
 */

ModelServer.prototype.cacheGetMemoryUsage = function (callback) {
    var self = this;
    self.cacheGetServer(
        { assertServer: false },
        function (error, server) {
            if (error) {
                callback(error);
                return;
            }

            var usage = {};
            if (server) {
                MEMORY_USAGE_KEYS.forEach(function (key) {
                    usage[key] = server[key];
                });
                callback(null, usage);
                return;
            } else {
                MEMORY_USAGE_KEYS.forEach(function (key) {
                    usage[key] = 0;
                });
                callback(null, usage);
            }
        });
};


/**
 * Update the disk usage cache for a particular server.
 */

ModelServer.prototype.cacheSetDiskUsage =
function (disk, callback) {
    var self = this;
    self.cacheUpdateServer(disk, callback);
};


/**
 * Fetch a server's cached disk usage information.
 */

ModelServer.prototype.cacheGetDiskUsage = function (callback) {
    var self = this;
    self.cacheGetServer(
        { assertServer: false },
        function (error, server) {
            if (error) {
                callback(error);
                return;
            }

            var usage = {};
            if (server) {
                DISK_USAGE_KEYS.forEach(function (key) {
                    usage[key] = server[key];
                });
                callback(null, usage);
            } else {
                DISK_USAGE_KEYS.forEach(function (key) {
                    usage[key] = 0;
                });

                callback(null, usage);
            }
        });
};


/**
 * Fetch a server's cached last_heartbeat value.
 */

ModelServer.prototype.cacheGetLastHeartbeat = function (callback) {
    var self = this;
    self.cacheGetServer(
        { assertServer: false },
        function (error, server) {
            if (error) {
                callback(error);
                return;
            }

            if (server) {
                callback(null, server.last_heartbeat);
                return;
            }

            callback(null, new Date(0));
        });
};

/**
 * Update a server's last_heartbeat cache value.
 */

ModelServer.prototype.cacheSetLastHeartbeat =
function (lastHeartbeat, callback) {
    var self = this;
    self.cacheUpdateServer({ last_heartbeat: lastHeartbeat }, callback);
};


/**
 * Update the vms cache for a particular server with a hash of VM values.
 */

ModelServer.prototype.cacheSetVms = function (vms, callback) {
    var self = this;
    self.cacheUpdateServer({ vms: vms }, callback);
};


/**
 * Fetch the VM cache for a particular server.
 */

ModelServer.prototype.cacheGetVms = function (callback) {
    var self = this;
    self.cacheGetServer(
        { assertServer: false },
        function (error, server) {
            if (error) {
                callback(error);
                return;
            }
            if (server) {
                var vms = server.vms || {};
                callback(null, vms);
                return;
            }
            callback(null, {});
        });
};

/**
 * Delete a server's cached VM info.
 */

ModelServer.prototype.cacheDelVms = function (callback) {
    var self = this;
    self.cacheUpdateServer({ vms: {} }, callback);
};


/**
 * Purge all references to a server
 */

ModelServer.prototype.cacheDeleteServerAll = function (callback) {
    var self = this;

    delete ModelServer.scache[self.uuid];
    callback();
};


/**
 * Test whether a VM exists on a particular server.
 */

ModelServer.prototype.cacheCheckVmExists =
function (vmUuid, callback) {
    var self = this;
    self.cacheGetServer(function (error, server) {
        if (error) {
            callback(error);
            return;
        }
        var exists = false;
        if (server && server.vms && server.vms[vmUuid]) {
            exists = true;
        }
        callback(null, exists);
    });
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


module.exports = ModelServer;
