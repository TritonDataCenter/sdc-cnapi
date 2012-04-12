var async = require('async');
var uuid = require('node-uuid');
var restify = require('restify');

function Server() {}

Server.list = function (req, res, next) {
    var self = this;
    var servers = [];

    async.waterfall([
        function (wf$callback) {
            self.model.listServers(
                {},
                function (error, s) {
                    if (error) {
                        return wf$callback(error);
                    }

                    servers = s;
                    return wf$callback();
                });
        }
    ],
    function (error) {
        if (error) {
            return next(
                new restify.InternalError(error.message));
        }

        res.send(servers);
        return next();
    });
};

Server.get = function (req, res, next) {
    var self = this;
    var servers = [];

    async.waterfall([
        function (wf$callback) {
            self.model.listServers(
                { uuid: req.params.uuid },
                function (error, s) {
                    if (error) {
                        return wf$callback(error);
                    }

                    servers = s;
                    return wf$callback();
                });
        }
    ],
    function (error) {
        if (error) {
            return next(
                new restify.InternalError(error.message));
        }

        res.send(servers);
        return next();
    });
};

function createTaskCallback(req, res, next) {
    return function (error, task_id) {
        res.send({ id: task_id });
        return next();
    };
}


function VM() {}

VM.load = function (req, res, next) {
    var self = this;
    self.model.loadVm(
        req.params.server_uuid,
        req.params.uuid,
        function (error, vm) {
            res.send(vm);
            return next();
        });
};

VM.start = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_boot',
        req.params,
        createTaskCallback(req, res, next));
};

VM.stop = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_shutdown',
        req.params,
        createTaskCallback(req, res, next));
};

VM.reboot = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_reboot',
        req.params,
        createTaskCallback(req, res, next));
};

VM.nop = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'nop',
        req.params,
        createTaskCallback(req, res, next));
};

VM.create = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_create',
        req.params,
        createTaskCallback(req, res, next));
};

VM.destroy = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_destroy',
        req.params,
        createTaskCallback(req, res, next));
};

function Task() {}

Task.get = function (req, res, next) {
    var self = this;
    res.send(self.model.tasks[req.params.taskid]);
    next();
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // List servers
    http.get(
        { path: '/servers', name: 'ListServers' },
        Server.list.bind(toModel));

    // Get server
    http.get(
        { path: '/servers/:server_uuid', name: 'GetServer' },
        Server.get.bind(toModel));

    // Create VM
    http.post(
        { path: '/servers/:server_uuid/vms', name: 'CreateVm' },
        VM.create.bind(toModel));

    // Load VM's properties from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'LoadVm' },
        VM.load.bind(toModel));

    // Start VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/start', name: 'StartVm' },
        VM.start.bind(toModel));

    // Stop VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/stop', name: 'StopVm' },
        VM.stop.bind(toModel));

    // Reboot VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/reboot', name: 'RebootVm' },
        VM.reboot.bind(toModel));

    // Delete a VM
    http.del(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'DestroyVm' },
        VM.destroy.bind(toModel));

    // No-op task
    http.get(
        { path: '/servers/:server_uuid/nop', name: 'DoNop' },
        VM.nop.bind(toModel));

    // Get task details
    http.get(
        { path: '/tasks/:taskid', name: 'GetTask' },
        Task.get.bind(toModel));

    // Pseudo-W3C (not quite) logging.
    http.on('after', function (req, res, name) {
        model.log.info('[%s] %s "%s %s" (%s)', new Date(), res.statusCode,
        req.method, req.url, name);
    });
}

exports.attachTo = attachTo;
