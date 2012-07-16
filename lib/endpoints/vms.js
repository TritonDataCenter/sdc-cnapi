var restify = require('restify');

function VM() {}

VM.load = function load(req, res, next) {
    var self = this;
    var serverUuid = req.params.server_uuid;
    var zoneUuid = req.params.uuid;

    if (!this.model.zones[serverUuid][zoneUuid]) {
        next(
            new restify.ResourceNotFoundError('No such zone: ' + zoneUuid));
        return;
    }

    self.model.loadVm(
        serverUuid,
        zoneUuid,
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
    var self = this;
    self.model.performVmTask('machine_update', true, req, res, next);
};

VM.start = function start(req, res, next) {
    var self = this;
    self.model.performVmTask('machine_boot', true, req, res, next);
};

VM.stop = function stop(req, res, next) {
    var self = this;
    self.model.performVmTask('machine_shutdown', true, req, res, next);
};

VM.reboot = function reboot(req, res, next) {
    var self = this;
    self.model.performVmTask('machine_reboot', true, req, res, next);
};

VM.create = function create(req, res, next) {
    var self = this;
    self.model.performVmTask('machine_create', false, req, res, next);
};

VM.destroy = function destroy(req, res, next) {
    var self = this;
    self.model.performVmTask('machine_destroy', true, req, res, next);
};

VM.nop = function nop(req, res, next) {
    var self = this;
    self.model.performVmTask('nop', true, req, res, next);
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // Create VM
    http.post(
        { path: '/servers/:server_uuid/vms', name: 'CreateVm' },
        VM.create.bind(toModel));

    // Load VM's details from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'LoadVm' },
        VM.load.bind(toModel));

    // Update VM's properties from the server (resize)
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/update', name: 'UpdateVm' },
        VM.update.bind(toModel));

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

}

exports.attachTo = attachTo;
