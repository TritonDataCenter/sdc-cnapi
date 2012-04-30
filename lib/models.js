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
    var ufds = self.ufds = new UFDS(self.config.ufds);
//     ufds.setLogLevel('trace');

    ufds.on('ready', function () {
        return callback();
    });
};

function serverJson(record) {
    return {
        uuid: record.uuid,
        datacenter: record.datacenter,
        hostname: record.hostname,
        ram: record.ram,
        reserved: record.reserved,
        cpu_cores: record.cpucores,
        os: record.os,
        cpu_virtualization: record.cpuvirtualization,
        status: record.status,
        vendor_number: record.vendornumber,
        vendor_model: record.vendormodel,
        manufacturer: record.manufacturer,
        headnode: record.headnode,
        lastboot: record.last_boot,
        bootargs: record.boot_args
    };
}

function sysinfoToLdapObject(sysinfo) {
    var bootargs =
        Object
            .keys(sysinfo['Boot Parameters'])
            .map(function (k) {
                return k + '=' + sysinfo['Boot Parameters'][k];
             })
            .join(' ');

    return {
        objectclass: 'server',
        reserved: 'true',
        status: 'running',
        datacenter: sysinfo.datacenter,
        uuid: sysinfo.UUID,
        hostname: sysinfo.Hostname,
        ram: sysinfo['MiB of Memory'],
        cpucores: sysinfo['CPU Total Cores'],
        os: sysinfo['Live Image'],
        cpuvirtualization: sysinfo['CPU Virtualization'],
        vendornumber: sysinfo['Serial Number'],
        vendormodel: sysinfo['Product'],
        manufacturer: sysinfo['Manufacturer'],
        lastboot: (new Date()).toISOString(),
        headnode: sysinfo['Boot Parameters']['headnode'] ? 'true' : 'false',
        bootargs: bootargs
    };
}

Model.prototype.createServerFromSysinfo = function (sysinfo, callback) {
    var self = this;
    var datacenter = sysinfo.datacenter = self.config.datacenter;

    var server = sysinfoToLdapObject(sysinfo);
    this.log.trace(server, 'Server object');
    var uuid = sysinfo['UUID'];

    var baseDn = sprintf(SERVER_FMT, uuid, datacenter);
    this.ufds.add(baseDn, server, function (err) {
        if (err) {
            callback(err);
        } else {
            self.log.info('Added server %s to ufds', uuid);
            callback(null, server);
        }
    });
};

Model.prototype.listServers = function (params, callback) {
    this.log.debug(params, 'Listing servers');
    var self = this;
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

    this.ufds.search(baseDn, options, function (err, items) {
        var servers = [];

        for (var i = 0; i < items.length; i++) {
            servers.push(serverJson(items[i]));
        }

        return callback(null, servers);
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

function createModel(config) {
    return new Model(config);
}

exports.createModel = createModel;
exports.createUfdsModel = createModel;
exports.Model = Model;
