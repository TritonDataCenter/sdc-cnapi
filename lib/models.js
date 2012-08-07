/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This is where the core of CNAPI abstractions and logic is defined:
 * - caching
 * - interacting with workflows
 * - communicating with servers
 */

var async = require('async');
var util = require('util');
var TaskClient = require('task_agent/lib/client');
var UFDS = require('sdc-clients').UFDS;
var sprintf = require('sprintf').sprintf;
var common = require('./common');
var execFile = require('child_process').execFile;
var fs = require('fs');
var restify = require('restify');
var Redis = require('./redis_client');
var WorkflowClient = require('wf-client');

var SUFFIX = 'o=smartdc';
var SERVERS = 'ou=servers, datacenter=%s, ' + SUFFIX;
var SERVER_FMT = 'uuid=%s,' + SERVERS;

var PROVISIONER = 'provisioner-v2';

function Model(config) {
    this.config = config;
    this.log = config.log;
    this.tasks = {};
}


/**
 * Connect the model instance to storange and API backends.
 */
Model.prototype.connect = function (callback) {
    var self = this;

    async.waterfall([
        function (cb) {
            self.redisClientCreate(cb);
        },
        function (cb) {
            self.taskClientCreate(cb);
        },
        function (cb) {
            self.ufdsClientConnect(cb);
        },
        function (cb) {
            self.workflowClientCreate(cb);
        }
    ],
    function (error) {
        if (error) {
            self.log.error(error);
            return callback(error);
        }
        return callback();
    });
};

/**
 * Disconnect model instance from storage and API backends.
 */
Model.prototype.disconnect = function (callback) {
    this.taskClient.end();
    this.ufds.close(callback);
};

/**
 * Pass in an AMQP connection object to be used by model.
 */
Model.prototype.useConnection = function (connection) {
    this.taskClient.useConnection(connection);
};

/**
 * Create a provisioner task client instance.
 */
Model.prototype.taskClientCreate = function (callback) {
    var self = this;
    this.taskClient = new TaskClient(self.config);
    callback();
};

/**
 * Connect the model instance to the UFDS service.
 */
Model.prototype.ufdsClientConnect = function (callback) {
    var self = this;
    var ufds;
    var ufdsTimeout;

    connect();

    function connect() {
        ufdsTimeout = setTimeout(function () {
            self.log.info('Reconnecting to UFDS');
            self.log.info('Closing connection');

            ufds.close(function () {
                self.log.info('Creating a new connection');
                connect();
            });
        }, 5000);

        ufds = self.setUfds(new UFDS(self.config.ufds));
        ufds.setLogLevel('trace');
        ufds.on('error', function (e) {
            self.log.error(e, 'There was a ufds error');
        });

        ufds.on('ready', function () {
            self.log.info('UFDS ready!');
            clearTimeout(ufdsTimeout);
            return callback();
        });
    }
};


/**
 * Assign a UFDS connection object to be used by the model.
 */
Model.prototype.setUfds = function (ufds) {
    this.ufds = ufds;
    return ufds;
};


/**
 * Assign a Workflow API client object to be used by the model.
 */
Model.prototype.setWfapi = function (wfapi) {
    this.wfapi = wfapi;
    return wfapi;
};

Model.prototype.setUr = function (ur) {
    this.ur = ur;
    return ur;
};

Model.prototype.setRedis = function (redis) {
    this.redis = redis;
};

Model.prototype.redisClientCreate = function (callback) {
    this.redis = new Redis({
        log: this.log,
        config: this.config.redis
    });
    callback();
};

Model.prototype.workflowClientCreate = function (callback) {
    var self = this;
    var config = {
        workflows: [ 'provision-cnapi', 'server-setup', 'server-sysinfo' ],
        url: self.config.wfapi.url,
        log: this.log,
        path: __dirname + '/workflows',

        forceReplace: true
    };

    this.workflow = new WorkflowClient(config);
    this.workflow.initWorkflows(callback);
};


/**
 * Create a server record in UFDS.
 */
Model.prototype.createServer = function (server, callback) {
    var self = this;
    var datacenter = server.datacenter = self.config.datacenter;

    this.log.info(server, 'Server object');
    var uuid = server['uuid'];

    var memory = server.memory;

    delete server.memory;

    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
    this.ufds.add(baseDn, server, function (error) {
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
        self.serverUpdateMemoryCache(uuid, memory, cb);
    }
};


/**
 * Modify a UFDS server record.
 */
Model.prototype.modifyServer = function (uuid, changes, callback) {
    var self = this;
    var datacenter = self.config.datacenter;

    this.log.debug('Modifying server, %s', uuid);
    this.log.trace(changes, 'Change set');

    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
    changes = changes.slice();
    changes.push({
        type: 'replace',
        modification: {
            last_updated: (new Date()).toISOString()
        }
    });

    this.ufds.modify(baseDn, changes, function (error) {
        if (error) {
            callback(error);
            return;
        } else {
            self.log.debug('Modified server %s in ufds', uuid);
            callback();
            return;
        }
    });
};


/**
 * Query UFDS for a list of servers matching certain criteria.
 */
Model.prototype.listServers = function (params, callback) {
    var self = this;

    this.log.debug(params, 'Listing servers');
    var baseDn;
    var uuid = params.uuid;
    var options;
    var wantArray = Array.isArray(uuid) || !uuid;
    var wantCache = params.wantCache;

    var datacenter = params.datacenter
                     ? params.datacenter : self.config.datacenter;

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

    this.log.debug(baseDn, 'Search baseDn');
    this.log.debug(options, 'Search options');

    this.ufds.search(baseDn, options, function (err, items) {
        if (err) {
            self.log.error(err, 'Error searching for servers.');
            callback(err);
            return;
        }
        self.log.debug(items, 'search items');

        if (!items.length) {
            callback();
            return;
        }

        var servers = [];

        async.forEachSeries(
            items,
            function (item, cb) {
                item.sysinfo = JSON.parse(item.sysinfo);

                if (item.setup === 'true') {
                    item.setup = true;
                } else if (item.setup === 'false') {
                    item.setup = false;
                }

                if (wantCache) {
                    self.log.debug(
                        'Looking up server %s memory in cache', item.uuid);
                    self.serverGetMemoryCache(
                        item.uuid,
                        function (cacheError, memory) {
                            self.log.info(
                                arguments,
                                'Looked up server memory in cache');
                            for (var m in memory) {
                                item[m] = memory[m];
                            }
                            add(item, cb);
                        });
                } else {
                    add(item, cb);
                }

                function add(i, cb2) {
                    servers.push(i);
                    cb2();
                }
            },
            function (feError) {
                if (wantArray) {
                    callback(null, servers);
                    return;
                } else if (!wantArray && servers.length === 1) {
                    callback(null, servers[0]);
                    return;
                } else {
                    callback(null, servers[0]);
                    return;
                }
            });
    });
};


/**
 * Delete a Server from UFDS.
 */
Model.prototype.deleteServer = function (uuid, callback) {
    var self = this;

    var datacenter = self.config.datacenter;

    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
    var options = {};

    self.ufds.search(baseDn, options, function (error, items) {
        async.forEachSeries(
            items,
            function (item, fe$callback) {
                self.ufds.del(item.dn, function (fe$error) {
                    fe$callback();
                });
            },
            function (fe$error) {
                return callback(fe$error);
            });
    });
};


/**
 * Look up a VM's information via a provsioner task. (Synchronous, does not
 * return until request completes.)
 */
Model.prototype.loadVm = function (serverUuid, vmUuid, callback) {
    var self = this;

    self.taskClient.getAgentHandle(
        PROVISIONER,
        serverUuid,
        function (handle) {
            handle.sendTask(
                'machine_load',
                { uuid: vmUuid },
                function (taskHandle) {
                    var error;

                    taskHandle.on('event', function (eventName, msg) {
                        if (eventName === 'error') {
                            self.log.error(
                                'Error received during loadVm: %s',
                                msg.error);
                            error = msg.error;
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


Model.prototype.zfsTask = function (task, uuid, options, callback) {
    var self = this;

    self.log.info(options);

    self.taskClient.getAgentHandle(PROVISIONER, uuid,
    function (handle) {
        handle.sendTask(task, options,
            function (taskHandle) {
                var error;

                taskHandle.on('event', function (eventName, msg) {
                    if (eventName === 'error') {
                        self.log.error(
                            'Error received during loadVm: %s',
                            msg.error);
                        error = msg.error;
                    } else if (eventName === 'finish') {
                        if (error) {
                            return (callback(new Error(error)));
                        } else {
                            return (callback(null, msg));
                        }
                    }
                    return (null);
                });
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
function createTaskHandler(self, eventCallback, callback) {
    return function (taskHandle) {
        var task = self.tasks[taskHandle.id] = {};
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
}


/*
 * Initiates a provisioner task.
 */
Model.prototype.sendProvisionerTask =
function (serverUuid, task, params, eventCallback, callback) {
    var self = this;
    self.log.info(params);
    this.taskClient.getAgentHandle(
        PROVISIONER,
        serverUuid,
        function (handle) {
            self.log.info(params);
            handle.sendTask(
                task,
                params,
                createTaskHandler(self, eventCallback, callback));
        });
};


/**
 * Create a Redis key for the VMs cache.
 */
function keyServerVms(uuid) {
    return sprintf('cnapi:servers:%s:vms', uuid);
}


/**
 * Create a Redis key for the server memory usage cache.
 */
function keyServerMemory(uuid) {
    return sprintf('cnapi:servers:%s:memory', uuid);
}


/**
 * Create a Redis key for the server.
 */
function keyServer(uuid) {
    return sprintf('cnapi:servers:%s', uuid);
}


/**
 * Update the Server cache with the sysinfo of a server.
 */
Model.prototype.serverUpdateCache = function (serverUuid, sysinfo, callback) {
    var key = keyServer(serverUuid);
    this.redis.getClient()
        .hmset(key, sysinfo, callback);
};


/**
 * Check the server cache for the existence of a particular server.
 */
Model.prototype.serverCheckExistsCache = function (serverUuid, callback) {
    var key = keyServer(serverUuid);
    this.redis.getClient()
        .exists(key, callback);
};

/**
 * Update the memory usage cache for a particular server.
 */
Model.prototype.serverUpdateMemoryCache =
function (serverUuid, memory, callback) {
    var key = keyServerMemory(serverUuid);
    this.redis.getClient()
        .hmset(key, memory, callback);
};


/**
 * Return the memory usage cache values for a particular server.
 */
Model.prototype.serverGetMemoryCache = function (serverUuid, callback) {
    var key = keyServerMemory(serverUuid);
    this.log.debug('Fetching memory info for %s', serverUuid);
    this.redis.getClient()
        .hgetall(key, callback);
};


/**
 * Update the vms cache for a particular server with a hash of VM values.
 */
Model.prototype.serverUpdateVmsCache = function (serverUuid, vms, callback) {
    var self = this;
    var key = keyServerVms(serverUuid);
    self.redis.getClient().multi()
        .del(keyServerVms(serverUuid))
        .hmset(key, vms)
        .exec(onExec);

    function onExec(error) {
        if (error) {
            self.log.error(
                error,
                'Error updating server (%s) vms', serverUuid);
            callback(error);
            return;
        }

        self.log.debug(
            'Updated redis vms cache for %s with %d vms',
            serverUuid, Object.keys(vms).length);
        callback();
    }
};


/**
 * Check if a VM exists on a particular server.
 */
Model.prototype.serverCheckVmExists =
function (serverUuid, vmUuid, callback) {
    var self = this;
    self.redis.getClient().hexists(
        keyServerVms(serverUuid), vmUuid, function (error, res) {
        callback(null, res);
    });
};

/**
 * Execute a provisioner task against a VM on a server, optionally ensuring
 * that the VM exists prior to executing.
 */
Model.prototype.performVmTask = function (task, checkExists, req, res, next) {
    var self = this;
    var serverUuid = req.params.server_uuid;
    var zoneUuid = req.params.uuid;

    if (checkExists) {
        self.serverCheckVmExists(
            serverUuid, zoneUuid, function (error, exists) {
            if (!exists) {
                next(
                    new restify.ResourceNotFoundError(
                        'No such zone: ' + zoneUuid));
                    return;
            }

            send();
        });
    } else {
        send();
    }

    function send() {
        self.sendProvisionerTask(
            req.params.server_uuid,
            task,
            req.params,
            createProvisionerEventHandler(self, req.params.jobid),
            createTaskCallback(req, res, next));
    }
};



function createProvisionerEventHandler(model, jobuuid) {
    var wfclient = model.wfapi.getClient();

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
}

function createTaskCallback(req, res, next) {
    return function (error, task_id) {
        res.send({ id: task_id });
        return next();
    };
}

/**
 * Return the default boot parameters to be used when booting a server.
 */
Model.prototype.getBootParamsDefault = function (callback) {
    var self = this;
    var params = {
        platform: 'latest',
        kernel_args: {}
    };

    params.kernel_args.rabbitmq = [
            self.config.amqp.username || 'guest',
            self.config.amqp.password || 'guest',
            self.config.amqp.host,
            self.config.amqp.port || 5672
          ].join(':');

    callback(null, params);
    return;
};

/**
 * Return the boot parameters to be used when booting a particular server.
 */
Model.prototype.getBootParamsByUuid = function (uuid, callback) {
    var self = this;

    self.listServers({ uuid: uuid }, function (error, servers) {
        if (error) {
            callback(error);
            return;
        }

        // This should trigger a 404 response
        if (servers.length !== 1) {
            callback(null, null);
            return;
        }

        var server = servers[0];

        var params = {
            platform: 'latest',
            kernel_args: {
                rabbitmq: [
                    self.config.amqp.username || 'guest',
                    self.config.amqp.password || 'guest',
                    self.config.amqp.host,
                    self.config.amqp.port || 5672
                ].join(':'),
                hostname: server.hostname
            }
        };

        callback(null, params);
        return;
    });
};

/**
 * Initiate a workflow, which can may be can be added to which is run whenever
 * a new server starts up and sends its sysinfo payload via Ur.
 */
Model.prototype.serverBeginSysinfoWorkflow = function (sysinfo, callback) {
    var self = this;

    var uuid = sysinfo.UUID;

    var params = {
        sysinfo: sysinfo,
        server_uuid: uuid,
        target: uuid
    };

    self.log.info('Instantiating server-sysinfo workflow');
    self.workflow.createJob(
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
 * Initiate a workflow which orchestrates and executes the steps required to
 * set up new server.
 */
Model.prototype.serverSetup = function (uuid, callback) {
    var self = this;

    var params = {
        cnapi_url: self.config.cnapi.url,
        assets_url: self.config.assets.url,
        server_uuid: uuid,
        target: uuid
    };

    self.log.info('Instantiating server-setup workflow');
    self.workflow.createJob(
        'server-setup',
        params,
        function (error, job) {
            if (error) {
                self.log.error('Error in workflow: %s', error.message);
                callback(error);
                return;
            }
            callback();
            return;
        });
};


/**
 * Execute a command on a particular server via Ur.
 */
Model.prototype.serverInvokeUrScript =
function (uuid, script, params, callback) {
    var self = this;

    var opts =  {
        uuid: uuid,
        message: {
            type: 'script',
            script: script,
            args: params.args || [],
            env: params.env || {}
        }
    };
    self.log.info('Sending compute node %s script', uuid);

    self.ur.execute(opts, function (err, stdout, stderr) {
        if (err) {
            self.log.error('Error raised by ur when ' +
                'running script: ' + err.message);
        }

        return (callback(err, stdout, stderr));
    });
};

/**
 * Create and return a new Model object.
 */

function createModel(config) {
    return new Model(config);
}

exports.createModel = createModel;
exports.Model = Model;
