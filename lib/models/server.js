/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This file contains all the Compute Server logic, used to interface with the
 * server as well as it's stored representation in the backend datastores.
 */

var async = require('async');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var common = require('../common');
var buckets = require('../apis/moray').BUCKETS;
var verror = require('verror');

var ModelBase = require('./base');
var ModelVM = require('./vm');

var PROVISIONER = 'provisioner';

/**
 * RFC 2254 Escaping of filter strings
 * @author [Austin King](https://github.com/ozten)
 */

function filterEscape(inp) {
    if (typeof (inp) === 'string') {
        var esc = '';
        for (var i = 0; i < inp.length; i++) {
            switch (inp[i]) {
                case '*':
                    esc += '\\2a';
                    break;
                case '(':
                    esc += '\\28';
                    break;
                case ')':
                    esc += '\\29';
                    break;
                case '\\':
                    esc += '\\5c';
                    break;
                case '\0':
                    esc += '\\00';
                    break;
                default:
                    esc += inp[i];
                    break;
            }
        }

        return esc;
    } else {
        return inp;
    }
}


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


ModelServer.init = function (model) {
    this.model = model;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelServer[p] = ModelBase.staticFn[p];
    });

    ModelServer.tasks = {};
    ModelServer.log = model.getLog();
};


ModelServer.createProvisionerEventHandler = function (model, jobuuid) {
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

    var extras = params.extras || { status: true };

    this.log.debug(params, 'Listing servers');

    var wantFinal = params.wantFinal;

    var filterParams = ['datacenter', 'setup', 'headnode'];
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
            paramsFilter.push(sprintf('(%s=%s)', p, filterEscape(params[p])));
        } else if (buckets.servers.bucket.index[p].type === 'number') {
            paramsFilter.push(sprintf('(%s=%s)', p, filterEscape(params[p])));
        } else if (buckets.servers.bucket.index[p].type === 'boolean') {
            paramsFilter.push(sprintf('(%s=%s)', p, filterEscape(params[p])));
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
        serial_speed: 115200,
        boot_params: {}
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
            serial_speed: 115200,
            boot_params: {}
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
                callback(verror.VError(
                    error, 'failed to store default server'));
                return;
            }

            var server = obj.value;
            if (!server.boot_params) {
                server.boot_params = {};
            }
            var boot_params = values.boot_params;

            for (var k in boot_params) {
                if (boot_params[k] === null) {
                    delete server.boot_params[k];
                    continue;
                }
                server.boot_params[k] = boot_params[k];
            }

            var names = ['default_console', 'serial', 'serial_speed'];

            names.forEach(function (n) {
                if (values[n] === null) {
                    delete server[n];
                    return;
                }
                server[n] = values[n] || server[n];
            });

            if (values.boot_platform) {
                server.boot_platform = values.boot_platform;
            }

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

ModelServer.prototype.reboot = function (callback) {
    var self = this;

    var uuid = this.uuid;
    var wfParams;

    self.getRaw(function (geterror, raw) {
        wfParams = {
            cnapi_url: ModelServer.getConfig().cnapi.url,
            server_uuid: uuid,
            target: uuid
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

                    for (var m in memory) {
                        server[m] = memory[m];
                    }

                    cb();
                });
        },
        function (cb) {
            if (skip('vms', fields)) {
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
                                server.vms[uuid] = JSON.parse(vms[uuid]);
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
function (heartbeat, callback) {
    var self = this;

    async.waterfall([
        // Update the server's zones cache
        updateCacheZones,

        // Update the server's memory cache
        updateCacheMemory,

        // Update the server's memory cache
        updateCacheStatus
    ],
    function (error) {
        callback(error);
    });

    function updateCacheZones(cb) {
        var vms = {};

        if (heartbeat.hasOwnProperty('vms')) {
            Object.keys(heartbeat.vms).forEach(function (uuid) {
                vms[uuid] = JSON.stringify(heartbeat.vms[uuid]);
            });
        } else {
            heartbeat.zoneStatus.forEach(function (zonerec) {
                var uuid = zonerec[4];
                vms[uuid] = '{}';
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
};


/**
 * Cache server memory usage values in Redis.
 */

ModelServer.prototype.updateMemoryFromHeartbeat =
function (heartbeat, callback) {
    var memoryKeys = [
        ['availrmem_bytes', 'memory_available_bytes'],
        ['arcsize_bytes', 'memory_arc_bytes'],
        ['total_bytes', 'memory_total_bytes'] ];

    var memory = {};

    memoryKeys.forEach(function (keys) {
        memory[keys[1]] = heartbeat.meminfo[keys[0]];
    });

    var serverModel = new ModelServer(this.uuid);
    serverModel.cacheSetMemoryUsage(memory, callback);
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
        this.log.debug('Fetching server %s from moray', uuid);
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
    server.boot_platform = sysinfo['Live Image'];
};

/**
 * Create a server object suitable for insertion into Moray from a sysinfo
 * object or heartbeat.
 */

ModelServer.prototype.initialServerValues = function (opts) {
    var server = {};
    var sysinfo = opts.sysinfo;
    var heartbeat = opts.heartbeat;

    server.datacenter = ModelServer.getConfig().datacenter;

    ModelServer.updateServerPropertiesFromSysinfo({
        sysinfo: sysinfo,
        server: server
    });

    server.overprovision_ratio = 1.0;
    server.reservation_ratio = 0.15;
    server.traits = {};
    server.rack_identifier = '';
    server.uuid = sysinfo.UUID;
    server.hostname = sysinfo.Hostname;
    server.reserved = false;

    server.boot_params = opts.boot_params.kernel_args || {};

    server.default_console = opts.boot_params.default_console || 'vga';
    server.serial = opts.boot_params.serial || 'ttyb';
    server.serial_speed = opts.boot_params.serial_speed || 115200;

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

    if (heartbeat) {
        var meminfo = heartbeat.meminfo;
        if (heartbeat.hasOwnProperty('meminfo'))  {
            server.memory = {
                memory_available_bytes: meminfo.availrmem_bytes,
                memory_arc_bytes: meminfo.arcsize_bytes,
                memory_total_bytes: meminfo.total_bytes
            };
        }
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
                    cb();
                });
        }
    ],
    function (error) {
        server = self.initialServerValues({
            boot_params: boot_params,
            heartbeat: opts.heartbeat,
            sysinfo: sysinfo,
            last_boot: opts.last_boot,
            setup: opts.setup
        });

        server.created = (new Date()).toISOString();

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
                self.uuid,
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

    var extras = { vms: true, memory: true, status: true, sysinfo: true };

    if (arguments.length === 2) {
        extras = arguments[0];
        callback = arguments[1];

        if (extras.all) {
            extras = { vms: true, memory: true, sysinfo: true, status: true  };
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
                cb();
            });
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

        self.log.info('Instantiating server-setup workflow');
        ModelServer.getWorkflow().getClient().createJob(
            'server-setup',
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
 * Factory reset a server.
 */

ModelServer.prototype.factoryReset = function (callback) {
    var self = this;

    var uuid = this.uuid;

    var params = {
        cnapi_url: ModelServer.getConfig().cnapi.url,
        assets_url: ModelServer.getConfig().assets.url,
        server_uuid: uuid,
        target: uuid
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
        kernel_args: {}
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

            console.dir(obj.value);

            var server = obj.value;
            params.platform = server.boot_platform;
            for (var k in server.boot_params) {
                params.kernel_args[k] = server.boot_params[k];
            }

            params.default_console = server.default_console;
            params.serial = server.serial;
            params.serial_speed = server.serial_speed;

            callback(null, params);
            return;
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
                rabbitmq: [
                    ModelServer.getConfig().amqp.username || 'guest',
                    ModelServer.getConfig().amqp.password || 'guest',
                    ModelServer.getConfig().amqp.host,
                    ModelServer.getConfig().amqp.port || 5672
                ].join(':'),
                hostname: server.hostname
            }
        };

        // Mix in the parameters from Moray.
        var bootParams = server.boot_params;

        if (bootParams) {
            for (var i in bootParams) {
                if (!bootParams.hasOwnProperty(i)) {
                    continue;
                }
                params.kernel_args[i] = bootParams[i];
            }
        }
        params.default_console = server.default_console;
        params.serial = server.serial;
        params.serial_speed = server.serial_speed;

        callback(null, params);
        return;
    });
};


/**
 * Set the boot parameters property on a server object.
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
        server.serial_speed = bootParams.serial_speed;

        server.boot_params = bootParams.boot_params;
        server.boot_platform = bootParams.boot_platform;
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

        if (bootParams.boot_params) {
            if (!server.boot_params) {
                server.boot_params = {};
            }
            for (var k in bootParams.boot_params) {
                if (bootParams.boot_params[k] === null) {
                    delete server.boot_params[k];
                    continue;
                }
                server.boot_params[k] = bootParams.boot_params[k];
            }
        }

        var names = ['default_console', 'serial', 'serial_speed'];

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
    return function (taskHandle) {
        var task = ModelServer.tasks[taskHandle.id] = {};
        self.log.info('Task id = %s', taskHandle.id);
        process.nextTick(function () {
            callback(null, taskHandle.id);
        });
        task.id = taskHandle.id;
        task.progress = 0;
        task.status = 'active';
        task.history = [];

        taskHandle.on('event', function (eventName, msg) {
            var event = {
                name: eventName,
                event: msg
            };
            self.log.debug(event, 'Event details');
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

            eventCallback(task.id, event);
        });
    };
};


/*
 * Initiates a provisioner task.
 */
ModelServer.prototype.sendProvisionerTask =
function (task, params, eventCallback, callback) {
    var self = this;
    self.log.info({server: self.uuid, task: task, params: params},
        'sendProvisionerTask');
    ModelServer.getTaskClient().getAgentHandle(
        PROVISIONER,
        self.uuid,
        function (handle) {
            handle.sendTask(
                task,
                params,
                ModelServer.createTaskHandler(self, eventCallback, callback));
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
 * Create a Redis key for the server.
 */
ModelServer.prototype.cacheKeyServer = function () {
    return sprintf('cnapi:servers:%s', this.uuid);
};


/**
 * Create a cache key for the VMs cache.
 */
ModelServer.prototype.cacheKeyServerVms = function () {
    return sprintf('cnapi:servers:%s:vms', this.uuid);
};


/**
 * Create a Redis key for the server memory usage cache.
 */
ModelServer.prototype.cacheKeyServerMemoryUsage = function () {
    return sprintf('cnapi:servers:%s:memory', this.uuid);
};

/**
 * Create a cache key for the VMs cache.
 */
ModelServer.prototype.cacheKeyServerStatus = function () {
    return sprintf('cnapi:servers:%s:status', this.uuid);
};


/**
 * Return a Server's cached memory usage information.
 */
ModelServer.prototype.cacheGetMemoryUsage = function (callback) {
    var key = this.cacheKeyServerMemoryUsage();
    ModelServer.getRedis()
        .hgetall(key, function (error, values) {
            if (error) {
                callback(error, values);
                return;
            }

            for (var v in values) {
                values[v] = Number(values[v]);
            }
            callback(null, values);
        });
};

/**
 * Update the Server cache with the sysinfo of a server.
 */
ModelServer.prototype.cacheSet = function (sysinfo, callback) {
    var key = this.cacheKeyServer();
    ModelServer.getRedis()
        .hmset(key, sysinfo, callback);
};

/**
 * Update the Server cache with the sysinfo of a server.
 */
ModelServer.prototype.cacheSetServer =
function (sysinfo, callback) {
    var key = this.cacheKeyServer();
    ModelServer.getRedis().hmset(key, sysinfo, callback);
};

/**
 * Set the status of a server.
 */
ModelServer.prototype.cacheSetServerStatus =
function () {
    var self = this;

    var status, expire = 10, callback;

    if (arguments.length === 2) {
        status = arguments[0];
        callback = arguments[1];
    } else if (arguments.length === 3) {
        status = arguments[0];
        expire = arguments[1];
        callback = arguments[2];
    }

    var key = this.cacheKeyServerStatus();
    ModelServer.getRedis().set(key, status, function (error) {
        if (error) {
            self.log.error('Could not cache server (%s) status', self.uuid);
            callback(error);
            return;
        }

        ModelServer.getRedis().expire(key, expire, function (expireError) {
            callback(expireError);
        });
    });
};


/**
 * Check the server cache for the existence of a particular server.
 */
ModelServer.prototype.cacheCheckServerExists =
function (callback) {
    var key = this.cacheKeyServer();
    ModelServer.getRedis().exists(key, callback);
};

/**
 * Update the memory usage cache for a particular server.
 */
ModelServer.prototype.cacheSetMemoryUsage =
function (memory, callback) {
    var key = this.cacheKeyServerMemoryUsage();
    ModelServer.getRedis().hmset(key, memory, callback);
};

/**
 * Update the memory usage cache for a particular server.
 */
ModelServer.prototype.cacheGetServerStatus =
function (callback) {
    var key = this.cacheKeyServerStatus();
    ModelServer.getRedis().get(key, callback);
};

/**
 * Fetch the VM cache for a particular server.
 */
ModelServer.prototype.cacheGetVms = function (callback) {
    var key = this.cacheKeyServerVms();
    ModelServer.getRedis().hgetall(key, callback);
};

/**
 * Delete the VM cache for a particular server.
 */
ModelServer.prototype.cacheDelVms = function (callback) {
    var key = this.cacheKeyServerVms();
    ModelServer.getRedis().del(key, callback);
};

/**
 * Purge all references to a server
 */
ModelServer.prototype.cacheDeleteServerAll = function (uuid, callback) {
    var self = this;
    self.log.info('Deleting all redis keys for %s', uuid);

    var keywildcard = sprintf('cnapi:servers:%s*', uuid);
    ModelServer.getRedis().keys(keywildcard, function (error, keys) {
        if (error) {
            self.log.error(
                error,
                'Error updating server (%s) vms', this.uuid);
            callback(error);
            return;
        }

        var delkeysfns = [];

        keys.map(function (key) {
            delkeysfns.push(function (cb) {
                ModelServer.getRedis().del(key, function (delError) {
                    self.log.info(
                        'Deleted key %s', key);
                    cb(delError);
                });
            });
        });

        async.parallel(
            delkeysfns,
            function (redisError) {
                if (redisError) {
                    self.log.error(
                        redisError,
                        'Error removing server (%s) from redis', self.uuid);
                }
                self.log.info('Done deleting all keys');
                callback(error);
            });
    });
};


/**
 * Update the vms cache for a particular server with a hash of VM values.
 */
ModelServer.prototype.cacheSetVms = function (vms, callback) {
    var self = this;
    var key = this.cacheKeyServerVms();

    delete vms.global;

    if (!Object.keys(vms).length) {
        callback();
        return;
    }

    ModelServer.getRedis().multi()
        .del(this.cacheKeyServerVms())
        .hmset(key, vms)
        .exec(onExec);

    function onExec(error) {
        if (error) {
            self.log.error(
                error,
                'Error updating server (%s) vms', this.uuid);
            callback(error);
            return;
        }

        self.log.trace(
            'Updated redis vms cache for %s with %d vms',
            self.uuid, Object.keys(vms).length);
        callback();
    }
};


/**
 * Check if a VM exists on a particular server.
 */
ModelServer.prototype.cacheCheckVmExists =
function (vmUuid, callback) {
    ModelServer.getRedis().hexists(
        this.cacheKeyServerVms(), vmUuid, callback);
};

/**
 * Return a VM model.
 */

ModelServer.prototype.getVM =
function (uuid) {
    return new ModelVM({ serverUuid: this.uuid, uuid: uuid });
};

module.exports = ModelServer;
