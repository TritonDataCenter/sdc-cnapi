var async = require('async');
var util = require('util');
var TaskClient = require('task_agent/lib/client');
var UFDS = require('sdc-clients').UFDS;
var sprintf = require('sprintf').sprintf;
var common = require('./common');
var execFile = require('child_process').execFile;
var fs = require('fs');

var SUFFIX = 'o=smartdc';
var SERVERS = 'ou=servers, datacenter=%s, ' + SUFFIX;
var SERVER_FMT = 'uuid=%s,' + SERVERS;

function Model(config) {
    this.config = config;
    this.servers = [];
    this.log = config.log;
    this.tasks = {};
}

Model.prototype.connect = function (callback) {
    var self = this;

    async.waterfall([
        function (wf$callback) {
            self.taskClientConnect(wf$callback);
        },
        function (wf$callback) {
            self.ufdsClientConnect(wf$callback);
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

Model.prototype.taskClientConnect = function (callback) {
    var self = this;
    self.config.amqp_use_system_config = false;
    var taskClient = this.taskClient = new TaskClient(self.config);

    taskClient.configureAMQP(function () {
        self.taskClient = taskClient;
        taskClient.connect(function () {
            self.log.info('Task client connected');
            return callback();
        });
    });
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

Model.prototype.setUr = function (ur) {
    this.ur = ur;
    return ur;
};

Model.prototype.createServer = function (server, callback) {
    var self = this;
    var datacenter = server.datacenter = self.config.datacenter;

    this.log.info(server, 'Server object');
    var uuid = server['uuid'];

    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
    this.ufds.add(baseDn, server, function (error) {
        if (error) {
            callback(error);
        } else {
            self.log.info('Added server %s to ufds', uuid);
            callback(null, server);
        }
    });
};

Model.prototype.modifyServer = function (uuid, changes, callback) {
    var self = this;
    var datacenter = self.config.datacenter;

    this.log.info('Modifying server, %s', uuid);
    this.log.info(changes, 'Change set');

    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);

    this.ufds.modify(baseDn, changes, function (error) {
        if (error) {
            callback(error);
            return;
        } else {
            self.log.info('Modified server %s in ufds', uuid);
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
    var filter = '';
    var options;

    var datacenter = params.datacenter
                     ? params.datacenter : self.config.datacenter;

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

    this.log.debug(baseDn, 'Search baseDn');
    this.log.debug(options, 'Search options');

    this.ufds.search(baseDn, options, function (err, items) {
        if (err) {
            self.log.error(err, 'Error searching for servers.');
            callback(err);
            return;
        }
        var servers = [];

        for (var i = 0; i < items.length; i++) {
            servers.push(items[i]);
        }

        callback(null, servers);
        return;
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
                                callback(new Error(msg.error));
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

    var serverUuid = uuid;
    var cookie = common.genId();
    var ts = common.timestamp();

    var cnapiJoysetupPath = '/opt/smartdc/cnapi/joysetup';
    var joysetupPath = '/opt/smartdc/joysetup';
    var joysetupper = cnapiJoysetupPath + '/joysetupper.sh';
    var joysetupTmpPath = '/var/tmp/joysetup-' + cookie;
    var joysetupScript = joysetupTmpPath + '/joysetupper-' + cookie + '-' + ts + '.sh';
    var message;

    var zpoolRe = new RegExp([
        '^(.+?)',
        '[A-Za-z0-9-]+',
        '([0-9.]+\\w)',
        '([0-9.]+\\w)',
        '([A-Z]+)',
        '(.+?)$'
    ].join('\\s+'));

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

                    wf$callback();
                    return;
                });
        },
        function (wf$callback) {
            // read contents of generated joysetup script
            self.log.info('Crafting Ur message payload');
            fs.readFile(joysetupScript, function (error, data) {
                if (error) {
                    self.log.error(
                        'Error reading generated %s: %s',
                        joysetupScript, error.message);
                    wf$callback(
                        new Error(
                            'Error reading generated joysetup script'));
                    return;
                }
                message = {
                    type: 'script',
                    script: data.toString()
                };

                wf$callback();
                return;
            });
        },
        function (wf$callback) {
            // store contents in paylaod
            // send payload to ur
            // wait for response from ur
            var opts =  {
                uuid: serverUuid,
                message: message
            };
            self.log.info(
                'Sending compute node %s joysetup script', serverUuid);
            self.ur.execute(opts, function (error, stdout, stderr) {
                if (error) {
                    self.log.error(
                        'Error raised by ur when'
                        + 'running joysetupper script');
                    self.log.error(
                        'STDOUT:', stdout);
                    self.log.error(
                        'STDERR:', stderr);
                    wf$callback(
                        new Error(
                            'Error in remote joysetup script execution'));
                    return;
                }
                self.log.info(
                    'Stdout:', stdout);
                self.log.info(
                    'Stderr:', stderr);

                wf$callback(null, stdout);
            });
        },
        function (stdout, wf$callback) {
            self.log.info(
                'Parsing server zpools');
            // scrape zpool information from output
            stdout.split('\n').forEach(function (line) {
                var m = line.match(zpoolRe);

                if (!m) {
                    return;
                }

                function normalizeSolarisSize(size) {
                    return size;
                }

                var zfsStoragePool = {
                    pool: m[1],
                    disk_in_gigabytes: normalizeSolarisSize(m[2]),
                    disk_available_in_gigabytes: normalizeSolarisSize(m[3]),
                    health: m[4],
                    mountpoint: m[5]
                };

                self.log.info(
                    zfsStoragePool,
                    'Should create this storage pool in ufds');
            });

            wf$callback();
        },
        function (wf$callback) {
            // Update server record in UFDS
            self.log.info('Should update UFDS record for server...');
            wf$callback();
        }
    ],
    function (wf$error) {
        if (wf$error) {
            callback(wf$error);
            return;
        }

        callback();
        return;
    });
};

function createModel(config) {
    return new Model(config);
}

exports.createModel = createModel;
exports.Model = Model;
