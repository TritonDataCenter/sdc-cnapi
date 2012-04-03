var async = require('async');
var util = require('util');
var TaskClient = require('task_agent/lib/client');
var UFDS = require('sdc-clients').UFDS;
var sprintf = require('sprintf').sprintf;

var SUFFIX = 'o=smartdc';
var SERVERS = 'ou=servers, datacenter=coal, ' + SUFFIX;
var SERVER_FMT = 'serverid=%s,' + SERVERS;

function Model(config) {
    this.config = config;
    this.servers = [];
    this.log = config.log;
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
        serverid: record.serverid,
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
    return {
        objectclass: 'server',

        reserved:          'true',
        status:            'running',

        serverid:          sysinfo.UUID,
        hostname:          sysinfo.Hostname,
        ram:               sysinfo['MiB of Memory'],
        cpucores:          sysinfo['CPU Total Cores'],
        os:                sysinfo['Live Image'],
        cpuvirtualization: sysinfo['CPU Virtualization'],
        vendornumber:      sysinfo['Serial Number'],
        vendormodel:       sysinfo['Product'],
        manufacturer:      sysinfo['Manufacturer'],
        headnode:          sysinfo['Boot Parameters']['headnode'] ? "true"  : "false",
        lastboot:          (new Date()).toISOString(),
        bootargs:
            Object
                .keys(sysinfo['Boot Parameters'])
                .map(function (k) {
                    return k + '=' + sysinfo['Boot Parameters'][k];
                 })
                .join(' ')
    };
}

Model.prototype.createServerFromSysinfo = function (sysinfo, callback) {
    var self = this;
    var server = sysinfoToLdapObject(sysinfo);
    this.log.trace(server, "Server object");
    var uuid = sysinfo['UUID'];

    // XXX unhardcode 'coal'- how do we know what this value should be?
    var baseDn = sprintf(SERVER_FMT, uuid);
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
    var baseDn;
    var serverid = params.serverid;
    var filter = '';
    var options;

    if (serverid) {
        baseDn = sprintf(SERVER_FMT, serverid, params.datacenter);
    } else {
        baseDn = SERVERS;
    }

    options = {
        scope: 'sub',
        filter: '(&(objectclass=server)' + filter + ')'
    };

    this.ufds.search(baseDn, options, function (err, items) {
        var servers = [];

        for (var i = 0; i < items.length; i++) {
            servers.push(serverJson(items[i]));
        }

        return callback(null, servers);
    });
};

Model.prototype.deleteServer = function (serverid, callback) {
    var self = this;
    var baseDn = sprintf(SERVER_FMT, serverid);
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

function createModel(config) {
    return new Model(config);
}

exports.createModel = createModel;
exports.createUfdsModel = createModel;
exports.Model = Model;
