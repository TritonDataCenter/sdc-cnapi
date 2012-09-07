/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This file contains all the Compute Server logic, used to interface with the
 * server as well as it's stored representation in the backend datastores.
 */

var async = require('async');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var ModelBase = require('./base');
var ModelVM = require('./vm');

var PROVISIONER = 'provisioner-v2';
var SUFFIX = 'o=smartdc';
var SERVERS = 'ou=servers, datacenter=%s, ' + SUFFIX;
var SERVER_FMT = 'uuid=%s,' + SERVERS;

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

    this.ufdsServer = null;
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
    var wfclient = ModelServer.getWfapi().getClient();

    return function (taskid, event) {
        if (!jobuuid) {
            return;
        }

        wfclient.log.info(
            'Posting task info (task %s) to workflow jobs endpoint (job %s)',
            taskid, jobuuid);
        wfclient.post(
            '/jobs/' + jobuuid + '/info',
            event,
            function (error, req, res, obj) {
                if (error) {
                    wfclient.log.error(
                        error, 'Error posting info to jobs endpoint');
                    return;
                }
                wfclient.log.info(
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

    this.log.debug(params, 'Listing servers');

    var baseDn;
    var uuid = params.uuid;
    var options;
    var wantCache = params.wantCache;

    var datacenter = params.datacenter
                     ? params.datacenter : ModelServer.getConfig().datacenter;

    var setupFlag = params.setup;
    var headnodeFlag = params.headnode;

    var filter = '';

    if (setupFlag) {
        if (setupFlag === 'true') {
            filter += '(setup=' + setupFlag + ')';
        } else if (setupFlag === 'false') {
            filter += '(|(setup=' + setupFlag + ')(!(setup=*)))';
        }
    }

    if (headnodeFlag) {
        if (headnodeFlag === 'true') {
            filter += '(headnode=' + headnodeFlag + ')';
        } else if (headnodeFlag === 'false') {
            filter += '(|(headnode=' + headnodeFlag + ')(!(headnode=*)))';
        }
    }

    if (Array.isArray(uuid)) {
        baseDn = sprintf(SERVERS, datacenter);
        var uuids = uuid.map(function (u) {
            return '(uuid=' + u + ')';
        }).join('');
        options = {
            scope: 'sub',
            filter: '(&(objectclass=server)(|' + uuids + ')' + filter + ')'
        };
    } else {
        if (uuid) {
            baseDn = sprintf(SERVER_FMT, uuid, datacenter);
        } else {
            uuid = '*';
            baseDn = sprintf(SERVERS, datacenter);
        }

        options = {
            scope: 'sub',
            filter: '(&(objectclass=server)(uuid=' + uuid + ')' + filter + ')'
        };
    }

    self.log.debug(baseDn, 'Search baseDn');
    self.log.debug(options, 'Search options');

    ModelServer.getUfds().search(baseDn, options, function (err, items) {
        if (err) {
            self.log.error(err, 'Error searching for servers.');
            callback(err);
            return;
        }
        self.log.debug(items, 'search items');

        var servers = [];

        async.forEachSeries(
            items,
            onItem,
            function (feError) {
                callback(null, servers);
            });

        function onItem(item, cb) {
            item.sysinfo = JSON.parse(item.sysinfo);

            if (item.setup === 'true') {
                item.setup = true;
            } else if (item.setup === 'false') {
                item.setup = false;
            }

            var serverModel = new ModelServer(item.uuid);

            if (wantCache) {
                self.log.debug(
                    'Looking up server %s memory in cache', item.uuid);
                serverModel.cacheGetMemoryUsage(
                    function (cacheError, memory) {
                        self.log.info(
                            arguments,
                            'Looked up server memory in cache');
                        for (var m in memory) {
                            item[m] = memory[m];
                        }
                        servers.push(item);
                        cb();
                    });
            } else {
                servers.push(item);
                cb();
            }
        }
    });
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
        target: uuid
    };

    self.log.info('Instantiating server-sysinfo workflow');
    ModelServer.getWorkflow().createJob(
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

        return (callback(err, stdout, stderr));
    });
};


/**
 * Fetch a server from ufds by its UUID.
 */

ModelServer.prototype.get = function (callback) {
    var self = this;

    if (self.ufdsServer) {
        this.log.debug('Reusing ufdsServer object', this.uuid);
        callback(null, self.ufdsServer);
        return;
    }

    this.log.debug('Fetching server %s from ufds', this.uuid);

    var uuid = this.uuid;
    var datacenter = ModelServer.getConfig().datacenter;
    var filter = '';
    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
    var options = {
        scope: 'sub',
        filter: '(&(objectclass=server)(uuid=' + uuid + ')' + filter + ')'
    };

    self.log.debug(baseDn, 'Search baseDn');
    self.log.debug(options, 'Search options');

    ModelServer.getUfds().search(baseDn, options, function (err, servers) {
        if (err) {
            self.log.error(err, 'Error searching for servers.');
            callback(err);
            return;
        }
        self.log.debug(servers, 'Returned servers');

        if (!servers.length) {
            callback();
            return;
        }

        var server = self.ufdsServer = servers[0];

        if (server.setup === 'true') {
            server.setup = true;
        } else if (server.setup === 'false') {
            server.setup = false;
        }

        if (server.headnode === 'true') {
            server.headnode = true;
        } else if (server.headnode === 'false') {
            server.headnode = false;
        }

        self.log.debug(
            'Looking up server %s memory in cache', self.uuid);

        self.cacheGetMemoryUsage(
            function (cacheError, memory) {
                self.log.info(
                    arguments,
                    'Looked up server memory in cache');
                for (var m in memory) {
                    server[m] = memory[m];
                }

                callback(null, server);
            });
    });
};


ModelServer.prototype.modify = function (changes, callback) {
    var self = this;
    var datacenter = ModelServer.getConfig().datacenter;

    this.log.debug('Modifying server, %s', self.uuid);
    this.log.trace(changes, 'Change set');

    var baseDn = sprintf(SERVER_FMT, this.uuid, datacenter);
    changes = changes.slice();
    changes.push({
        type: 'replace',
        modification: {
            last_updated: (new Date()).toISOString()
        }
    });

    ModelServer.getUfds().modify(baseDn, changes, function (error) {
        if (error) {
            callback(error);
            return;
        } else {
            self.log.debug('Modified server %s in ufds', self.uuid);
            callback();
            return;
        }
    });
};


/**
 * Create a server object suitable for insertion into UFDS from a sysinfo
 * object or heartbeat.
 */
ModelServer.prototype.valuesFromSysinfo = function (opts) {
    var server = {};
    var sysinfo = opts.sysinfo;
    var heartbeat = opts.heartbeat;

    server.sysinfo = JSON.stringify(sysinfo);
    server.datacenter = ModelServer.getConfig().datacenter;

    server.uuid = sysinfo.UUID;
    server.hostname = sysinfo.Hostname;
    server.reserved = 'false';
    server.current_platform = sysinfo['Live Image'];
    server.boot_platform = sysinfo['Live Image'];
    server.headnode
        = sysinfo['Boot Parameters']['headnode'] === 'true' ? 'true' : 'false';
    server.setup = sysinfo['Zpool'] ? 'true' : 'false';

    if (opts.last_boot) {
        server.last_boot = opts.last_boot;
    }

    server.status = 'running';
    server.default_console = 'vga';
    server.serial = 'ttyb';
    server.serial_speed = '115200';
    server.objectclass = 'server';

    if (heartbeat) {
        var meminfo = heartbeat.meminfo;
        server.memory = {};
        server.memory.memory_available_bytes
            = meminfo.availrmem_bytes.toString();
        server.memory.memory_arc_bytes = meminfo.arcsize_bytes.toString();
        server.memory.memory_total_bytes = meminfo.total_bytes.toString();
    }

    return server;
};

ModelServer.prototype.setValues = function (opts, callback) {
    this.values = this.valuesFromSysinfo({
        heartbeat: opts.heartbeat,
        sysinfo: opts.sysinfo,
        last_boot: opts.last_boot
    });

    callback();
};


/**
 * Create a server object in UFDS. Use the sysinfo values if they are given in
 * the opts argument. If no sysinfo values are given, do a sysinfo lookup on
 * the server via Ur, and then create the server using those values.
 * (createUfdsServerObject)
 */
ModelServer.prototype.create = function (opts, callback) {
    var self = this;
    var uuid = this.uuid;
    var sysinfo;

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
            self.setValues({
                heartbeat: opts.heartbeat,
                sysinfo: sysinfo,
                last_boot: opts.last_boot

            }, cb);
        }
    ],
    function (error) {
        self.values.last_updated = (new Date()).toISOString();

        self.log.debug(this.values, 'Creating server in UFDS');
        self.addServerToUfds(
            self.values,
            function (createError, createdServer) {
                if (createError) {
                    self.log.info('Error creating server in UFDS');
                    callback(createError);
                    return;
                }
                self.log.info('Created server entry in UFDS');
                callback(null, self.values);
                return;
            });
    });
};

/**
 * Create a server record in UFDS.
 */

ModelServer.prototype.addServerToUfds = function (server, callback) {
    var self = this;
    var datacenter = server.datacenter = ModelServer.getConfig().datacenter;

    this.log.info(server, 'Server object');
    var uuid = server['uuid'];

    var memory = server.memory;

    delete server.memory;

    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
    ModelServer.getUfds().add(baseDn, server, function (error) {
        if (error) {
            callback(error);
        } else {
            self.log.info('Added server %s to ufds', uuid);
            cacheMemory(function () {
                callback(null, server);
            });
        }
    });

    function cacheMemory(cb) {
        self.cacheSetMemoryUsage(memory, cb);
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
        memory[keys[1]] = heartbeat.meminfo[keys[0]].toString();
    });

    var serverModel = new ModelServer(this.uuid);
    serverModel.cacheSetMemoryUsage(memory, callback);
};


/**
 * Initiate a workflow which orchestrates and executes the steps required to
 * set up new server.
 */

ModelServer.prototype.setup = function (callback) {
    var self = this;

    var uuid = this.uuid;

    var params = {
        cnapi_url: ModelServer.getConfig().cnapi.url,
        assets_url: ModelServer.getConfig().assets.url,
        server_uuid: uuid,
        target: uuid
    };

    self.log.info('Instantiating server-setup workflow');
    ModelServer.getWorkflow().createJob(
        'server-setup',
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

    callback(null, params);
    return;
};

/**
 * Return the boot parameters to be used when booting a particular server.
 */
ModelServer.prototype.getBootParams = function (callback) {
    var self = this;

    self.get(function (error, server) {
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

        callback(null, params);
        return;
    });
};



/**
 * Factory reset a server.
 */

ModelServer.prototype.factoryReset = function (callback) {
    var self = this;

    var script = [
        '#!/bin/bash',
        'set -o xtrace',
        'SYS_ZPOOL=$(/usr/bin/svcprop -p config/zpool smartdc/init)',
        '[[ -n ${SYS_ZPOOL} ]] || SYS_ZPOOL=zones',
        '/usr/sbin/zfs set smartdc:factoryreset=yes ${SYS_ZPOOL}/var',
        'exit 113'
    ].join('\n');

    self.invokeUrScript(script, {}, function (error) {
        callback(error);
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
    self.log.info(params);
    ModelServer.getTaskClient().getAgentHandle(
        PROVISIONER,
        self.uuid,
        function (handle) {
            self.log.info(params);
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

    self.log.info('getting agent handle', uuid);
    ModelServer.getTaskClient().getAgentHandle(PROVISIONER, uuid,
    function (handle) {
        self.log.info('got agent handle');
        handle.sendTask(task, options,
            function (taskHandle) {
                var error;

                taskHandle.on('event', function (eventName, msg) {
                    self.log.info(arguments, 'got prov event');
                    if (eventName === 'error') {
                        self.log.error(
                            'Error received during loadVm: %s',
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
        });
    });
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
 * Return a Server's cached memory usage information.
 */
ModelServer.prototype.cacheGetMemoryUsage = function (callback) {
    var key = this.cacheKeyServerMemoryUsage();
    ModelServer.getRedis()
        .hgetall(key, callback);
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
