/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints for interacting with virtual machines.
 *
 */

var restify = require('restify');

var ModelServer = require('../models/server');
var ModelVM = require('../models/vm');

function VM() {}

VM.init = function () {
    VM.log = ModelVM.log;
};

var vmLoadTimeoutSeconds = 60;

VM.load = function load(req, res, next) {
    var responded;

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for machine_load request to return'));
    }, vmLoadTimeoutSeconds * 1000);

    req.params.vm.load(
        function (error, vm) {
            clearTimeout(timeout);

            if (responded && error) {
                VM.log.error(error.message);
                return;
            }

            if (responded) {
                VM.log.warn('Got a reply back from an expired request');
                return;
            }

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
    var vm = req.params.server.getVM(req.params.uuid);
    vm.performVmTask('machine_create', false, req, res, next);
};

VM.destroy = function destroy(req, res, next) {
    req.params.vm.performVmTask('machine_destroy', true, req, res, next);
};

VM.nop = function nop(req, res, next) {
    req.params.vm.performVmTask('nop', true, req, res, next);
};


function VmSnapshots() {}

VmSnapshots.init = function () {
    VmSnapshots.log = ModelVM.log;
};

VmSnapshots.create = function (req, res, next) {
    req.params.vm.performVmTask(
        'machine_create_snapshot', true, req, res, next);
};

VmSnapshots.rollback = function (req, res, next) {
    req.params.vm.performVmTask(
        'machine_rollback_snapshot', true, req, res, next);
};

VmSnapshots.destroy = function (req, res, next) {
    req.params.vm.performVmTask(
        'machine_delete_snapshot', true, req, res, next);
};

function attachTo(http, model) {
    VM.init();

    var ensure = require('../endpoints').ensure;

    var preconditionsGetVm = ensure({
        connectionTimeoutSeconds: 60 * 60,
        model: model,
        prepopulate: ['server', 'vm'],
        connected: ['amqp', 'moray', 'redis']
    });

    var preconditionsNoVm = ensure({
        connectionTimeoutSeconds: 60 * 60,
        model: model,
        prepopulate: ['server'],
        connected: ['amqp', 'moray', 'redis']
    });


    /**
     *
     * VM Snapshots
     *
     */

    // Create VM
    http.post(
        { path: '/servers/:server_uuid/vms', name: 'VmCreate' },
        preconditionsNoVm,
        VM.create);

    // Load VM's details from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'VmLoad' },
        preconditionsGetVm, VM.load);

    // Update VM's properties from the server (resize)
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/update', name: 'VmUpdate' },
        preconditionsGetVm, VM.update);

    // Start VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/start', name: 'VmStart' },
        preconditionsGetVm, VM.start);

    // Stop VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/stop', name: 'VmStop' },
        preconditionsGetVm, VM.stop);

    // Reboot VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/reboot', name: 'VmReboot' },
        preconditionsGetVm, VM.reboot);

    // Delete a VM
    http.del(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'VmDestroy' },
        preconditionsGetVm, VM.destroy);


    /**
     *
     * VM Snapshots
     *
     */

    // Create VM Snapshot
    http.put(
        {
            path: '/servers/:server_uuid/vms/:uuid/snapshots',
            name: 'VmSnapshotCreate'
        },
        preconditionsGetVm,
        VmSnapshots.create);


    // Rollback VM to Snapshot
    http.put(
        {
            path: '/servers/:server_uuid'
                  + '/vms/:uuid/snapshots/:snapshot_name/rollback',
            name: 'VmSnapshotRollback'
        },
        preconditionsGetVm,
        VmSnapshots.rollback);

    // Destroy a VM snapshot
    http.del(
        {
            path: '/servers/:server_uuid'
                  + '/vms/:uuid/snapshots/:snapshot_name',
            name: 'VmSnapshotDestroy'
        },
        preconditionsGetVm,
        VmSnapshots.destroy);


    /**
     *
     * Misc
     *
     */

    // No-op task
    http.get(
        { path: '/servers/:server_uuid/nop', name: 'DoNop' },
        preconditionsGetVm, VM.nop);
}

exports.attachTo = attachTo;
