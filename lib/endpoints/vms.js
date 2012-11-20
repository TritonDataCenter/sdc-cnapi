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

    var ensure = require('../endpoints').ensure;

    var preconditionsListVms = ensure({
        connectionTimeoutSeconds: 60 * 60,
        model: model,
        prepopulate: ['server'],
        connected: ['amqp', 'moray', 'redis']
    });

    var preconditionsGetVm = ensure({
        connectionTimeoutSeconds: 60 * 60,
        model: model,
        prepopulate: ['server', 'vm'],
        connected: ['amqp', 'moray', 'redis']
    });

    // Create VM
    http.post(
        { path: '/servers/:server_uuid/vms', name: 'CreateVm' },
        preconditionsListVms,
        VM.create);

    // Load VM's details from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'LoadVm' },
        preconditionsGetVm, VM.load);

    // Update VM's properties from the server (resize)
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/update', name: 'UpdateVm' },
        preconditionsGetVm, VM.update);

    // Start VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/start', name: 'StartVm' },
        preconditionsGetVm, VM.start);

    // Stop VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/stop', name: 'StopVm' },
        preconditionsGetVm, VM.stop);

    // Reboot VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/reboot', name: 'RebootVm' },
        preconditionsGetVm, VM.reboot);

    // Delete a VM
    http.del(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'DestroyVm' },
        preconditionsGetVm, VM.destroy);

    // No-op task
    http.get(
        { path: '/servers/:server_uuid/nop', name: 'DoNop' },
        preconditionsGetVm, VM.nop);
}

exports.attachTo = attachTo;
