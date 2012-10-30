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
var buckets = require('../moray/buckets');
var moray_client = require('moray');

var ModelBase = require('./base');
var ModelVM = require('./vm');

var PROVISIONER = 'provisioner';
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

    this.value = {};
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
        workflow.client.post(
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
//     var options = params.options;

    this.log.debug(params, 'Listing servers');

    var wantFinal = params.wantFinal;

//     var filterParams = ['datacenter', 'setup', 'headnode'];
    var filter = '';

    if (Array.isArray(uuid)) {
        var uuidFilter = uuid.map(function (u) {
            return '(uuid=' + u + ')';
        });
        filter += '(|' + uuidFilter + ')';
    } else if (uuid) {
        filter += '(uuid=' + uuid + ')';
    } else {
        filter += '(uuid=*)';
    }

    var moray = ModelServer.getMoray();

    var req = moray.findObjects(buckets.servers.name, filter, {});

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

        async.mapSeries(
            servers,
            function (server, cb) {
                var serverModel = new ModelServer(server.uuid);
                serverModel.setRaw(server);

                serverModel.getFinal(function (error, s) {
                    cb(null, s);
                });

//                 serverModel.cacheGetMemoryUsage(
//                     function (cacheError, memory) {
//                         for (var m in memory) {
//                             server[m] = memory[m];
//                         }
//
//                         cb(null, server);
//                     });
            },
            function (error, results) {
                callback(null, results);
            });
    }
};

// ModelServer.listUfds = function (params, callback) {
//     var self = this;
//
//     this.log.debug(params, 'Listing servers');
//
//     var baseDn;
//     var uuid = params.uuid;
//     var options;
//     var wantCache = params.wantCache;
//
//     var datacenter = params.datacenter
//                    ? params.datacenter : ModelServer.getConfig().datacenter;
//
//     var setupFlag = params.setup;
//     var headnodeFlag = params.headnode;
//
//     var filter = '';
//
//     if (setupFlag) {
//         if (setupFlag === 'true') {
//             filter += '(setup=' + setupFlag + ')';
//         } else if (setupFlag === 'false') {
//             filter += '(|(setup=' + setupFlag + ')(!(setup=*)))';
//         }
//     }
//
//     if (headnodeFlag) {
//         if (headnodeFlag === 'true') {
//             filter += '(headnode=' + headnodeFlag + ')';
//         } else if (headnodeFlag === 'false') {
//             filter += '(|(headnode=' + headnodeFlag + ')(!(headnode=*)))';
//         }
//     }
//
//     if (Array.isArray(uuid)) {
//         baseDn = sprintf(SERVERS, datacenter);
//         var uuids = uuid.map(function (u) {
//             return '(uuid=' + u + ')';
//         }).join('');
//         options = {
//             scope: 'sub',
//             filter: '(&(objectclass=server)(|' + uuids + ')' + filter + ')'
//         };
//     } else {
//         if (uuid) {
//             baseDn = sprintf(SERVER_FMT, uuid, datacenter);
//         } else {
//             uuid = '*';
//             baseDn = sprintf(SERVERS, datacenter);
//         }
//
//         options = {
//             scope: 'sub',
//         filter: '(&(objectclass=server)(uuid=' + uuid + ')' + filter + ')'
//         };
//     }
//
//     self.log.debug(baseDn, 'Search baseDn');
//     self.log.debug(options, 'Search options');
//
//     ModelServer.getUfds().search(baseDn, options, function (err, items) {
//         if (err) {
//             self.log.error(err, 'Error searching for servers.');
//             callback(err);
//             return;
//         }
//         self.log.debug(items, 'search items');
//
//         var servers = [];
//
//         async.forEachSeries(
//             items,
//             onItem,
//             function (feError) {
//                 callback(null, servers);
//             });
//
//         function onItem(item, cb) {
//             item.sysinfo = JSON.parse(item.sysinfo);
//
//             if (item.setup === 'true') {
//                 item.setup = true;
//             } else if (item.setup === 'false') {
//                 item.setup = false;
//             }
//
//             var serverModel = new ModelServer(item.uuid);
//
//             if (wantCache) {
//                 self.log.debug(
//                     'Looking up server %s memory in cache', item.uuid);
//                 serverModel.cacheGetMemoryUsage(
//                     function (cacheError, memory) {
//                         self.log.info(
//                             arguments,
//                             'Looked up server memory in cache');
//                         for (var m in memory) {
//                             item[m] = memory[m];
//                         }
//                         servers.push(item);
//                         cb();
//                     });
//             } else {
//                 servers.push(item);
//                 cb();
//             }
//         }
//     });
// };


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

        callback(err, stdout, stderr);
        return;
    });
};


/**
 * Fetch a server from ufds by its UUID.
 */

ModelServer.prototype.errorFmt = function (str) {
    return sprintf('Error (server=%s): %s', this.uuid, str);
};

ModelServer.prototype.applyCachedValues = function (callback) {
    var self = this;

    var server = clone(self.value.raw);

    async.waterfall([
        function (cb) {
            self.cacheGetServerStatus(
                function (statusError, status) {
                    if (statusError) {
                        self.log.error(
                            statusError,
                            self.errorFmt('fetching server status'));

                        cb(statusError);
                        return;
                    }

                    server.status = status || 'unknown';
                    self.log.info(
                        'Status for %s was %s', self.uuid, server.status);
                    cb();
                });
        },
        function (cb) {
            self.cacheGetMemoryUsage(
                function (cacheError, memory) {
                    if (cacheError) {
                        self.log.error(
                            cacheError,
                            self.errorFmt('fetching memory values'));

                        callback(cacheError);
                        return;
                    }

                    for (var m in memory) {
                        server[m] = memory[m];
                    }

                    callback(null, server);
                });
        }
    ],
    function () {
        callback(null, server);
    });
};

ModelServer.prototype.convertValueTypes = function () {
    var self = this;
    self.value.raw.setup = new Boolean(self.value.raw.setup);
    self.value.raw.reserved = new Boolean(self.value.raw.reserved);
    self.value.raw.headnode = new Boolean(self.value.raw.headnode);
};

ModelServer.prototype.getRaw = function (callback) {
    var self = this;
    var uuid = self.uuid;
    var server;

    if (self.value.raw) {
        this.log.debug('Reusing raw value for %s', uuid);
        server = clone(self.value.raw);
        callback(null, server);
    } else {
        this.log.debug('Fetching server %s from moray', uuid);
        ModelServer.getMoray().getObject(
            buckets.servers.name,
            uuid,
            function (error, obj) {
                if (error && error.name === 'ObjectNotFoundError') {
                    self.log.error('Server %s not found in moray', uuid);
                    callback();
                    return;
                } else if (error) {
                    self.log.error(error, 'Error fetching server from moray');
                    callback(error);
                    return;
                }
                self.log.info({ server: server }, 'Server object');
                server = clone(obj.value);
                self.value.raw = obj.value;

                server = clone(self.value.raw);
                callback(null, server);
            });
    }
};

// ModelServer.prototype.getFromUfds = function (callback) {
//     var self = this;
//
//     if (self.ufdsServer) {
//         this.log.debug('Reusing ufdsServer object', this.uuid);
//         callback(null, self.ufdsServer);
//         return;
//     }
//
//     this.log.debug('Fetching server %s from ufds', this.uuid);
//
//     var uuid = this.uuid;
//     var datacenter = ModelServer.getConfig().datacenter;
//     var filter = '';
//     var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
//     var options = {
//         scope: 'sub',
//         filter: '(&(objectclass=server)(uuid=' + uuid + ')' + filter + ')'
//     };
//
//     self.log.debug(baseDn, 'Search baseDn');
//     self.log.debug(options, 'Search options');
//
//     ModelServer.getUfds().search(baseDn, options, function (err, servers) {
//         if (err) {
//             self.log.error(err, 'Error searching for servers.');
//             callback(err);
//             return;
//         }
//         self.log.debug(servers, 'Returned servers');
//
//         if (!servers.length) {
//             callback();
//             return;
//         }
//
//         var server = self.ufdsServer = servers[0];
//
//         if (server.setup === 'true') {
//             server.setup = true;
//         } else if (server.setup === 'false') {
//             server.setup = false;
//         }
//
//         if (server.headnode === 'true') {
//             server.headnode = true;
//         } else if (server.headnode === 'false') {
//             server.headnode = false;
//         }
//
//         self.log.debug(
//             'Looking up server %s memory in cache', self.uuid);
//
//         self.cacheGetServerStatus(
//             function (statusError, status) {
//                 server.status = status || 'unknown';
//                 self.log.info('Status was %s, server status', self.uuid);
//
//                 self.cacheGetMemoryUsage(
//                     function (cacheError, memory) {
//                         self.log.info(
//                             arguments,
//                             'Looked up server memory in cache');
//                         for (var m in memory) {
//                             server[m] = memory[m];
//                         }
//
//                         callback(null, server);
//                     });
//             });
//
//     });
// };


/**
 * Apply server property changes to the backend UFDS representation.
 */

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

    server.sysinfo = sysinfo;
    server.datacenter = ModelServer.getConfig().datacenter;

    server.uuid = sysinfo.UUID;
    server.hostname = sysinfo.Hostname;
    server.reserved = false;
    server.current_platform = sysinfo['Live Image'];
    server.boot_platform = sysinfo['Live Image'];
    server.headnode
        = sysinfo['Boot Parameters']['headnode'] === 'true';
    server.setup = sysinfo['Zpool'] ? true : false;

    if (opts.last_boot) {
        server.last_boot = opts.last_boot;
    }

    server.default_console = 'vga';
    server.serial = 'ttyb';
    server.serial_speed = 115200;

    if (heartbeat) {
        var meminfo = heartbeat.meminfo;
        server.memory = {
            memory_available_bytes: meminfo.availrmem_bytes,
            memory_arc_bytes: meminfo.arcsize_bytes,
            memory_total_bytes: meminfo.total_bytes
        };
    }

    return server;
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
    var server;

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
        }
    ],
    function (error) {
        server = self.valuesFromSysinfo({
            heartbeat: opts.heartbeat,
            sysinfo: sysinfo,
            last_boot: opts.last_boot
        });

        server.last_updated = (new Date()).toISOString();
        server.status = 'running';

        self.addServerToMoray(
            server,
            function (createError, createdServer) {
                if (createError) {
                    self.log.error(
                        createError,
                        'Error creating server in moray');
                    callback(createError);
                    return;
                }
                self.log.info('Created server entry in UFDS');

                self.cacheSetServerStatus(
                    self.value.status,
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
 * Create a server record in UFDS.
 */

ModelServer.prototype.addServerToMoray = function (server, callback) {
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

function clone(val) {
    return JSON.parse(JSON.stringify(val));
}

ModelServer.prototype.setRaw = function (raw, callback) {
    this.value.raw = clone(raw);
};

ModelServer.prototype.getFinal = function (callback) {
    var self = this;

    self.getRaw(function (getError, server) {
        if (!server) {
            callback();
            return;
        }

        self.applyCachedValues(function (cacheError, s) {
            callback(null, s);
        });
    });
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

    ModelServer.getWorkflow().createJob(
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

        // Mix in the parameters from UFDS.
        var ufdsParams = server.boot_params;

        if (ufdsParams) {
            ufdsParams = JSON.parse(ufdsParams);
            for (var i in ufdsParams) {
                if (!ufdsParams.hasOwnProperty(i)) {
                    continue;
                }
                params.kernel_args[i] = ufdsParams[i];
            }
        }

        callback(null, params);
        return;
    });
};


/**
 * Set the boot parameters property on a server object.
 */

ModelServer.prototype.setBootParams = function (bootParams, callback) {
    var self = this;

    for (var i in bootParams) {
        if (!bootParams.hasOwnProperty(i)) {
            continue;
        }

        if (!common.isString(bootParams[i])) {
            callback(new Error('Property \"' + i + '" is not a string value'));
            return;
        }
    }

    var serialized = JSON.stringify(bootParams);
    var changes = [
        {
            type: 'replace',
            modification: {
                last_updated: (new Date()).toISOString(),
                boot_params: serialized
            }
        }
    ];
    self.modify(changes, function (error) {
        callback(error);
        return;
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

    ModelServer.getTaskClient().getAgentHandle(PROVISIONER, uuid,
    function (handle) {
        handle.sendTask(task, options,
            function (taskHandle) {
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
function (status, callback) {
    var self = this;
    var key = this.cacheKeyServerStatus();
    ModelServer.getRedis().set(key, status, function (error) {
        if (error) {
            self.log.error('Could not cache server (%s) status', self.uuid);
            callback(error);
            return;
        }

        ModelServer.getRedis().expire(key, 10, function (expireError) {
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
