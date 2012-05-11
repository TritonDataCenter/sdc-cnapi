var async = require('async');
var util = require('util');
var TaskClient = require('task_agent/lib/client');
var UFDS = require('sdc-clients').UFDS;
var sprintf = require('sprintf').sprintf;

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
    ufds.setLogLevel('trace');

    ufds.on('ready', function () {
        return callback();
    });
};

Model.prototype.setUfds = function (ufds) {
    this.ufds = ufds;
    return ufds;
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
                    taskHandle.on('event', function (eventName, msg) {
                        if (eventName === 'error') {
                            callback(null, { error: msg.error });
                        } else if (eventName === 'finish') {
                            callback(null, msg);
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

    params.kernel_args.rabbitmq
        = [ self.config.amqp.host,
            self.config.amqp.username || 'guest',
            self.config.amqp.password || 'guest',
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
                    self.config.amqp.host,
                    self.config.amqp.username || 'guest',
                    self.config.amqp.password || 'guest',
                    self.config.amqp.port || 5672
                ].join(':'),
                hostname: server.hostname
            }
        };

        callback(null, params);
        return;
    });
};

function createModel(config) {
    return new Model(config);
}

exports.createModel = createModel;
exports.Model = Model;
