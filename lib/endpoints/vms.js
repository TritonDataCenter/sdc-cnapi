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

    function initializeServer(req, res, next) {
        req.params.server = new ModelServer(req.params.server_uuid);

        req.params.server.getRaw(function (error, server) {
            var errorMsg;
            // Check if any servers were returned
            if (!server) {
                errorMsg
                    = 'Server ' + req.params.server_uuid + ' not found';
                next(
                    new restify.ResourceNotFoundError(errorMsg));
                return;
            }

            next();
        });
    }

    function initializeVm(req, res, next) {
        var uuid = req.params.uuid;
        req.params.server.cacheCheckVmExists(
            req.params.uuid,
            function (cacheError, exists) {
                var errorMsg;
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

    function initializeNewVm(req, res, next) {
        var uuid = req.params.uuid;
        req.params.vm = req.params.server.getVM(uuid);
        next();
    }

    var beforeCheckVm = [initializeServer, initializeVm];
    var beforeNoCheckVm = [initializeServer, initializeNewVm];

    // Create VM
    http.post(
        { path: '/servers/:server_uuid/vms', name: 'CreateVm' },
        beforeNoCheckVm, VM.create);

    // Load VM's details from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'LoadVm' },
        beforeCheckVm, VM.load);

    // Update VM's properties from the server (resize)
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/update', name: 'UpdateVm' },
        beforeCheckVm, VM.update);

    // Start VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/start', name: 'StartVm' },
        beforeCheckVm, VM.start);

    // Stop VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/stop', name: 'StopVm' },
        beforeCheckVm, VM.stop);

    // Reboot VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/reboot', name: 'RebootVm' },
        beforeCheckVm, VM.reboot);

    // Delete a VM
    http.del(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'DestroyVm' },
        beforeCheckVm, VM.destroy);

    // No-op task
    http.get(
        { path: '/servers/:server_uuid/nop', name: 'DoNop' },
        beforeCheckVm, VM.nop);
}

exports.attachTo = attachTo;
