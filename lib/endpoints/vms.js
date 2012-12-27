/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints for interacting with virtual machines.
 */

var restify = require('restify');

var ModelServer = require('../models/server');
var ModelVM = require('../models/vm');

function VM() {}

VM.init = function () {
    VM.log = ModelVM.log;
};

var vmLoadTimeoutSeconds = 60;

/**
 * Query the server for the VM's details.
 *
 * @name VmLoad
 * @endpoint (GET /servers/:server_uuid/vms/:uuid)
 *
 * @param jobid String Post information to workflow with this id
 *
 * @response 204 Object Task was sent to server
 * @response 404 Object No such VM
 * @response 404 Object No such server
 */

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


/**
 * Modify the system parameters of the VM identified by `:uuid` on server with
 * UUID `:server_uuid`.
 *
 * @name VmUpdate
 * @endpoint (POST /servers/:server\_uuid/vms/:uuid/update)
 *
 * @param jobid String Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/update
 *          -d '{ "ram": 512 }'
 */

VM.update = function update(req, res, next) {
    req.params.vm.performVmTask('machine_update', true, req, res, next);
};


/**
 * Boot up a vm which is in the 'stopped' state.
 *
 * @name VmStart
 * @endpoint (POST /servers/:server_uuid/vms/:uuid/start)
 *
 * @param jobid String Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/start
 */

VM.start = function start(req, res, next) {
    req.params.vm.performVmTask('machine_boot', true, req, res, next);
};


/**
 * Shut down a VM which is in the 'running' state.
 *
 * @name VmStop
 * @endpoint (POST /servers/:server\_uuid/vms/:uuid/stop)
 *
 * @param jobid String Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/stop
 */

VM.stop = function stop(req, res, next) {
    req.params.vm.performVmTask('machine_shutdown', true, req, res, next);
};


/**
 * Reboot a VM which is in the 'running' state.
 *
 * @name VmReboot
 * @endpoint (POST /servers/:server\_uuid/vms/:uuid/reboot)
 *
 * @param jobid String Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/reboot
 */

VM.reboot = function reboot(req, res, next) {
    req.params.vm.performVmTask('machine_reboot', true, req, res, next);
};


/*
 * Create a VM on the specified server.
 *
 * @name VmReboot
 * @endpoint (POST /servers/:server_uuid/vms/:uuid/reboot)
 *
 * @param jobid String Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example PUT /servers/<server-uuid>/vms/<vm-uuid>
 */

VM.create = function create(req, res, next) {
    var vm = req.params.server.getVM(req.params.uuid);
    vm.performVmTask('machine_create', false, req, res, next);
};


/**
 * Delete the specified VM.
 *
 * @name VmReboot
 * @endpoint (POST /servers/:server_uuid/vms/:uuid/reboot)
 *
 * @param jobid String Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example DELETE /servers/<server-uuid>/vms/<vm-uuid>
 */

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
