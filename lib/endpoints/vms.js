var restify = require('restify');

var ModelServer = require('../models/server');
var ModelVM = require('../models/vm');

function VM() {}

VM.init = function () {
    VM.log = ModelVM.log;
};

VM.load = function load(req, res, next) {
    req.params.vm.load(
        function (error, vm) {
            if (error) {
                next(new restify.InternalError(error.message));
                return;
            }
            res.send(vm);
            next();
            return;
        });
};

VM.update = function update(req, res, next) {
    req.params.vm.performVmTask('machine_update', true, req, res, next);
};

VM.start = function start(req, res, next) {
    req.params.vm.performVmTask('machine_boot', true, req, res, next);
};

VM.stop = function stop(req, res, next) {
    req.params.vm.performVmTask('machine_shutdown', true, req, res, next);
};

VM.reboot = function reboot(req, res, next) {
    req.params.vm.performVmTask('machine_reboot', true, req, res, next);
};

VM.create = function create(req, res, next) {
    req.params.vm.performVmTask('machine_create', false, req, res, next);
};

VM.destroy = function destroy(req, res, next) {
    req.params.vm.performVmTask('machine_destroy', true, req, res, next);
};

VM.nop = function nop(req, res, next) {
    req.params.vm.performVmTask('nop', true, req, res, next);
};

function attachTo(http, model) {
    VM.init();

    var before = [
        function (req, res, next) {
            var self = this;
            var errorMsg;

            if (!req.params.server_uuid) {
                next();
                return;
            }

            var uuid = req.params.uuid;

            req.params.server = new ModelServer(req.params.server_uuid);

            req.params.server.getRaw(function (error, server) {
                // Check if any servers were returned
                if (!server) {
                    errorMsg
                        = 'Server ' + req.params.server_uuid + ' not found';
                    next(
                        new restify.ResourceNotFoundError(errorMsg));
                    return;
                }

                req.params.serverAttributes = server;

                if (self.name === 'CreateVm') {
                    req.params.vm = req.params.server.getVM(uuid);
                    next();
                } else {
                    req.params.server.cacheCheckVmExists(
                        req.params.uuid,
                        function (cacheError, exists) {
                            if (!exists) {
                                errorMsg = 'VM ' + uuid + ' not found';
                                next(
                                    new restify.ResourceNotFoundError(
                                        errorMsg));
                                    return;
                            }

                            req.params.vm = req.params.server.getVM(uuid);
                            next();
                        });
                }
            });
        }
    ];

    // Create VM
    http.post(
        { path: '/servers/:server_uuid/vms', name: 'CreateVm' },
        before, VM.create);

    // Load VM's details from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'LoadVm' },
        before, VM.load);

    // Update VM's properties from the server (resize)
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/update', name: 'UpdateVm' },
        before, VM.update);

    // Start VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/start', name: 'StartVm' },
        before, VM.start);

    // Stop VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/stop', name: 'StopVm' },
        before, VM.stop);

    // Reboot VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/reboot', name: 'RebootVm' },
        before, VM.reboot);

    // Delete a VM
    http.del(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'DestroyVm' },
        before, VM.destroy);

    // No-op task
    http.get(
        { path: '/servers/:server_uuid/nop', name: 'DoNop' },
        before, VM.nop);
}

exports.attachTo = attachTo;
