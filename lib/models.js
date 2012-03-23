var async = require('async');
var createUfdsClient = require('../lib/ufds').createUfdsClient;
var TaskClient = require('task_agent/lib/client');

function Model(options) {
    this.options = options;
    this.servers = [ { uuid: '123', hostname: 'testserver' } ];
}

Model.prototype.connect = function (callback) {
    var self = this;

    async.waterfall([
        function (wf$callback) {
            var taskClient = new TaskClient();
            taskClient.configureAMQP(function () {
                self.taskClient = taskClient;
                taskClient.connect(function () {
                    return wf$callback();
                });
            });
        },
        function (wf$callback) {
            var ufdsClient = createUfdsClient(self.options.ufdsSettings);
            self.ufdsClient = ufdsClient;
            return wf$callback();
        }
    ],
    function (error) {
        return callback();
    });
};

Model.prototype.getServers = function (callback) {
    return callback(null, this.servers);
};

Model.prototype.getServer = function (uuid, callback) {
    return callback(null, this.servers[0]);
};

Model.prototype.getVm = function (serverUuid, vmUuid, callback) {
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
