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

var SUFFIX = 'o=smartdc';
var SERVERS = 'ou=servers, datacenter=%s, ' + SUFFIX;
var SERVER_FMT = 'uuid=%s,' + SERVERS;

function Model(config) {
    this.config = config;
    this.log = config.log;
    this.tasks = {};
}

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
        }
        // XXX SETUP UR HERE INSTEAD OF lib/cnapi.js
    ],
    function (error) {
        if (error) {
            self.log.error(error);
            return callback(error);
        }
        return callback();
    });
};

Model.prototype.disconnect = function (callback) {
    this.taskClient.end();
    this.ufds.close(callback);
};

Model.prototype.useConnection = function (connection) {
    this.taskClient.useConnection(connection);
};

Model.prototype.taskClientCreate = function (callback) {
    var self = this;
    this.taskClient = new TaskClient(self.config);
    callback();
};

Model.prototype.ufdsClientConnect = function (callback) {
    var self = this;
    var ufds = self.setUfds(new UFDS(self.config.ufds));
    // ufds.setLogLevel('trace');

    ufds.on('ready', function () {
        return callback();
    });
};

Model.prototype.setUfds = function (ufds) {
    this.ufds = ufds;
    return ufds;
};

Model.prototype.setWfapi = function (wfapi) {
    this.wfapi = wfapi;
    return wfapi;
};

Model.prototype.setUr = function (ur) {
    this.ur = ur;
    return ur;
};

Model.prototype.redisClientCreate = function (callback) {
    this.redis = new Redis({
        log: this.log,
        config: this.config.redis
    });
    callback();
};

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
    var filter = '';

    if (setupFlag) {
        if (setupFlag === 'true') {
            filter += '(setup=' + setupFlag + ')';
        } else if (setupFlag === 'false') {
            filter += '(|(setup=' + setupFlag + ')(!(setup=*)))';
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

Model.prototype.loadVm = function (serverUuid, vmUuid, callback) {
    var self = this;

    self.taskClient.getAgentHandle(
        'provisioner-v2',
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

Model.prototype.sendProvisionerTask =
function (serverUuid, task, params, eventCallback, callback) {
    var self = this;
    self.log.info(params);
    this.taskClient.getAgentHandle(
        'provisioner-v2',
        serverUuid,
        function (handle) {
            self.log.info(params);
            handle.sendTask(
                task,
                params,
                createTaskHandler(self, eventCallback, callback));
        });
};

function keyServerVms(uuid) {
    return sprintf('cnapi:servers:%s:vms', uuid);
}

function keyServerMemory(uuid) {
    return sprintf('cnapi:servers:%s:memory', uuid);
}

function keyServer(uuid) {
    return sprintf('cnapi:servers:%s', uuid);
}

Model.prototype.serverUpdateCache = function (serverUuid, sysinfo, callback) {
    var key = keyServer(serverUuid);
    this.redis.getClient()
        .hmset(key, sysinfo, callback);
};

Model.prototype.serverCheckExistsCache = function (serverUuid, callback) {
    var key = keyServer(serverUuid);
    this.redis.getClient()
        .exists(key, callback);
};

Model.prototype.serverUpdateMemoryCache =
function (serverUuid, memory, callback) {
    var key = keyServerMemory(serverUuid);
    this.redis.getClient()
        .hmset(key, memory, callback);
};

Model.prototype.serverGetMemoryCache = function (serverUuid, callback) {
    var key = keyServerMemory(serverUuid);
    this.log.debug('Fetching memory info for %s', serverUuid);
    this.redis.getClient()
        .hgetall(key, callback);
};

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

Model.prototype.serverCheckVmExists =
function (serverUuid, vmUuid, callback) {
    var self = this;
    self.redis.getClient().hexists(
        keyServerVms(serverUuid), vmUuid, function (error, res) {
        callback(null, res);
    });
};

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

Model.prototype.serverSetup = function (uuid, callback) {
    var self = this;

    var cookie = common.genId();
    var ts = common.timestamp();

    var cnapiJoysetupPath = '/opt/smartdc/cnapi/joysetup';
    var joysetupper = cnapiJoysetupPath + '/joysetupper.sh';
    var joysetupTmpPath = '/var/tmp/joysetup-' + cookie;
    var joysetupScript
        = joysetupTmpPath + '/joysetupper-' + cookie + '-' + ts + '.sh';
    var script;

    async.waterfall([
        function (wf$callback) {
            self.log.info('Generating compute node joysetup script');
            execFile(
                joysetupper,
                [ joysetupScript ],
                function (error, stdout, stderr) {
                    if (error) {
                        self.log.error(
                            'Error executing %s: %s',
                            joysetupper, stderr.toString());

                        wf$callback(
                            new Error(
                                'Error creating server setup script'));
                        return;
                    }
                    self.log.error(
                        'STDOUT:', stdout);
                    self.log.error(
                        'STDERR:', stderr);

                    wf$callback();
                    return;
                });
        },
        function (wf$callback) {
            // read contents of generated joysetup script
            self.log.info('Crafting Ur message payload');
            fs.readFile(joysetupScript, function (err, data) {
                if (err) {
                    self.log.error('Error reading generated %s: %s',
                        joysetupScript, err.message);
                    return (wf$callback(new Error(
                        'Error reading generated joysetup script')));
                }

                script = data.toString();
                return (wf$callback());
            });
        },
        function (wf$callback) {
            // send script to ur and wait for response
            self.serverInvokeUrScript(uuid, script,
                function (err, stdout, stderr) {
                if (err) {
                    self.log.error('Error raised by ur when' +
                        'running joysetupper script');
                    self.log.error('STDOUT:', stdout);
                    self.log.error('STDERR:', stderr);
                    return (wf$callback(new Error(
                        'Error in remote joysetup script execution')));
                }

                return (wf$callback());
            });
        },
        function (wf$callback) {
            // Set the server's setup attribute to 'true'
            var changes = [
                {
                    type: 'replace',
                    modification: {
                        setup: 'true'
                    }
                }
            ];

            self.log.info('Marking server %s as "setup"', uuid);
            self.modifyServer(uuid, changes, function (modifyError) {
                if (modifyError) {
                    self.log.error(
                        modifyError,
                        'Error marking server %s as setup in UFDS', uuid);
                    wf$callback(modifyError);
                    return;
                }
            });
        }    ],
    function (wf$error) {
        if (wf$error) {
            callback(wf$error);
            return;
        }

        callback();
        return;
    });
};

Model.prototype.serverInvokeUrScript = function (uuid, script, callback) {
    var self = this;

    var opts =  {
        uuid: uuid,
        message: {
            type: 'script',
            script: script
        }
    };
    self.log.info('Sending compute node %s script', uuid);

    self.ur.execute(opts, function (err, stdout, stderr) {
        if (err) {
            self.log.error('Error raised by ur when' +
                'running script: ' + err.message);
        }

        return (callback(err, stdout, stderr));
    });
};

function createModel(config) {
    return new Model(config);
}

exports.createModel = createModel;
exports.Model = Model;
