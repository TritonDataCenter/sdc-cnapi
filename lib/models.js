var async = require('async');
var util = require('util');
var TaskClient = require('task_agent/lib/client');
var UFDS = require('sdc-clients').UFDS;
var sprintf = require('sprintf').sprintf;

var SUFFIX = 'o=smartdc';
var SERVERS = 'ou=servers, datacenter=coal, ' + SUFFIX;
var SERVER_FMT = 'serverid=%s,' + SERVERS;

function Model(options) {
    this.options = options;
    this.servers = [];
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
        console.dir(arguments);
        return callback();
    });
};

Model.prototype.disconnect = function (callback) {
    this.taskClient.end();
    this.ufds.close(callback);
};

Model.prototype.taskClientConnect = function (callback) {
    var self = this;
    var taskClient = this.taskClient = new TaskClient();

    taskClient.configureAMQP(function () {
        self.taskClient = taskClient;
        taskClient.connect(function () {
            console.info('Task client connected');
            return callback();
        });
    });
};

Model.prototype.ufdsClientConnect = function (callback) {
    var self = this;
    var ufds = self.ufds = new UFDS(self.options.ufds);
    ufds.setLogLevel('trace');

    ufds.on('ready', function () {
        return callback();
    });

//     ufds.on('error', function (error) {
//         console.warn('ufds error %s', error.message);
//         self.emit('error', error);
//     });
};

function serverJson(record) {
    return {
        uuid: record.uuid,
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
        headnode:          sysinfo['Boot Parameters']['headnode'],
        lastboot:          (new Date()).toISOString(),
        bootargs: 
            Object
                .keys(sysinfo['Boot Parameters'])
                .map(function (k) {
                    return k + '=' + sysinfo['Boot Parameters'][k]
                 })
                .join(' ')
    };
}

Model.prototype.createServerFromSysinfo = function (sysinfo, callback) {
    var server = sysinfoToLdapObject(sysinfo);
    console.dir(server);
    var uuid = sysinfo['UUID'];

    // XXX unhardcode 'coal'- how do we know what this value should be?
    var baseDn = sprintf(SERVER_FMT, uuid);
    this.ufds.add(baseDn, server, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null, server);
        }
    });
}

Model.prototype.listServers = function (params, callback) {
    console.info('Listening');
    var baseDn;
    var uuid = params.uuid;
    var filter = '';
    var options;

    if (uuid) {
        baseDn = sprintf(SERVER_FMT, uuid, params.datacenter);
    } else {
        baseDn = SERVERS;
    }

//     if (params.datacenter) {
//         filter += sprintf('(datacenter=%s)', params.datacenter);
//     }
//     else {
//         filter += '(datacenter=*)';
//     }

    options = {
        scope: 'sub',
        filter: '(&(objectclass=server)' + filter + ')'
    };

    console.info('Searching');
    console.log(baseDn);
    console.dir(options);

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
    var baseDn = sprintf(SERVER_FMT, uuid);
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

function createModel(options) {
    return new Model(options);
}

exports.createModel = createModel;
exports.createUfdsModel = createModel;
exports.Model = Model;
