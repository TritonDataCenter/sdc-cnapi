/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints for interacting with virtual machines.
 */

var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var url = require('url');
var dns = require('dns');

var validation = require('../validation/endpoints');
var ModelServer = require('../models/server');
var ModelVM = require('../models/vm');

function VM() {}

VM.init = function () {
    VM.log = ModelVM.log;
};

var vmValidationRules = {
    'jobid': ['optional', 'isStringType'],
    'uuid': ['isStringType']
};


/**
 * Query the server for a list of VMs.
 *
 * @name VmList
 * @endpoint GET /servers/:server_uuid/vms
 * @section Virtual Machines
 *
 * @response 204 Array List of VMs
 * @response 404 Object No such server
 */

VM.list = function list(req, res, next) {
    var server = req.stash.server;

    server.cacheGetVms(function (error, vms) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        var response = [];

        for (var i in vms) {
            try {
                response.push(JSON.parse(vms[i]));
            }
            catch (e) {
                req.log.error(error);
                next(new restify.InternalError(error.message));
                return;
            }
        }

        res.send(200, response);
        next();
    });
};

var vmLoadTimeoutSeconds = 60;

/**
 * Query the server for the VM's details.
 *
 * @name VmLoad
 * @endpoint GET /servers/:server_uuid/vms/:uuid
 * @section Virtual Machines
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 204 Object Task was sent to server
 * @response 404 Object No such VM
 * @response 404 Object No such server
 */

VM.load = function load(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for machine_load request to return'));
    }, vmLoadTimeoutSeconds * 1000);

    req.stash.vm.load(
        function (error, vm) {
            clearTimeout(timeout);

            if (responded && error) {
                req.log.error(error.message);
                return;
            }

            if (responded) {
                req.log.warn('Got a reply back from an expired request');
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
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/update
 * @section Virtual Machines
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/update
 *          -d '{ "ram": 512 }'
 */

VM.update = function update(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_update', true, req, res, next);
};


/**
 * Boot up a vm which is in the 'stopped' state.
 *
 * @name VmStart
 * @endpoint POST /servers/:server_uuid/vms/:uuid/start
 * @section Virtual Machines
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/start
 */

VM.start = function start(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_boot', true, req, res, next);
};


/**
 * Shut down a VM which is in the 'running' state.
 *
 * @name VmStop
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/stop
 * @section Virtual Machines
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/stop
 */

VM.stop = function stop(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_shutdown', true, req, res, next);
};


/**
 * Reboot a VM which is in the 'running' state.
 *
 * @name VmReboot
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/reboot
 * @section Virtual Machines
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/reboot
 */

VM.reboot = function reboot(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_reboot', true, req, res, next);
};


/*
 * Create a VM on the specified server.
 *
 * @name VmCreate
 * @endpoint POST /servers/:server_uuid/vms
 * @section Virtual Machines
 *
 * @param {String} jobid Create a new virtual machine on the given server
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms
 */

VM.create = function create(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    // To support 6.5.* compute nodes
    // http://$IMGAPI_IP/images/$IMAGE_UUID/file
    var imgapi_url = req.stash.app.config.imgapi.url;

    var image_uuid;
    if (req.params.brand === "kvm") {
               if (req.params.hasOwnProperty('disks') && req.params.disks[0]) {
            image_uuid = req.params.disks[0].image_uuid;
        }
    } else {
        image_uuid = req.params.image_uuid;
    }

    if (typeof (image_uuid) !== 'string') {
        throw new Error('invalid image_uuid: ' + JSON.stringify(image_uuid)
            + ' (type: ' + typeof(image_uuid) + ')');
    }

    if (!req.params.image ||
        !req.params.image.files ||
        !req.params.image.files.length)
    {
        throw new Error(
            'missing required parameter images.files');
    }

    var urlParts = url.parse(imgapi_url);
    var hostname = urlParts.hostname;

    dns.resolve(hostname, function (error, addrs) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        // Pick one at random from list
        hostname = addrs[Math.floor(Math.random() * addrs.length)];

        delete urlParts.host;
        urlParts.hostname = hostname;
        urlParts.pathname = sprintf('/images/%s/file', image_uuid);

        req.params.dataset_url_compression
            = req.params.image.files[0].compression;
        req.params.dataset_url = url.format(urlParts);

        var vm = req.stash.server.getVM(req.params.uuid);
        vm.performVmTask('machine_create', false, req, res, next);
    });
};


/*
 * Reprovision a given VM.
 *
 * @name VmReprovision
 * @endpoint POST /servers/:server_uuid/vms/:uuid/reprovision
 * @section Virtual Machines
 *
 * @param {String} jobid Create a new virtual machine on the given server
 * @param {String} image_uuid Reprovision using the new image_uuid
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/reprovision
 */

VM.reprovision = function reprovision(req, res, next) {
    var reprovisionValidationRules = {
        'jobid': ['optional', 'isStringType'],
        'uuid': ['isStringType', 'isTrim'],
        'image_uuid': ['isStringType', 'isTrim']
    };

    if (validation.ensureParamsValid(req, res, reprovisionValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_reprovision', true, req, res, next);
};


/**
 * Delete the specified VM.
 *
 * @name VmDestroy
 * @endpoint DELETE /servers/:server_uuid/vms/:uuid
 * @section Virtual Machines
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example DELETE /servers/<server-uuid>/vms/<vm-uuid>
 */

VM.destroy = function destroy(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_destroy', true, req, res, next);
};

VM.nop = function nop(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('nop', true, req, res, next);
};


function VmSnapshots() {}

VmSnapshots.init = function () {
    VmSnapshots.log = ModelVM.log;
};


/**
 * Task a snapshot of a VM.
 *
 * @name VmSnapshotCreate
 * @endpoint PUT /servers/:server_uuid/vms/:uuid/snapshots
 * @section Virtual Machine Snapshots
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example PUT /servers/<server-uuid>/vms/:uuid/snapshots
 */

VmSnapshots.create = function (req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask(
        'machine_create_snapshot', true, req, res, next);
};

/**
 * Roll back to a previous snapshot of a VM.
 *
 * @name VmSnapshotRollback
 * @endpoint PUT /servers/:ser_uuid/vms/:uuid/snapshots/:snapshot_name/rollback
 * @section Virtual Machine Snapshots
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example PUT /servers/<server-uuid>/vms/:uuid/snapshots
 */

VmSnapshots.rollback = function (req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask(
        'machine_rollback_snapshot', true, req, res, next);
};

/**
 * Delete a VM's snapshot.
 *
 * @name VmSnapshotDestroy
 * @endpoint DELETE /servers/:ser_uuid/vms/:uuid/snapshots/:snapshot_name
 * @section Virtual Machine Snapshots
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example DELETE /servers/<server-uuid>/vms/:uuid/snapshots/:snapshot_name
 */
VmSnapshots.destroy = function (req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask(
        'machine_delete_snapshot', true, req, res, next);
};

function attachTo(http, app) {
    VM.init();

    var ensure = require('../endpoints').ensure;

    var preconditionsGetVm = ensure({
        connectionTimeoutSeconds: 60 * 60,
        app: app,
        prepopulate: ['server', 'vm'],
        connected: ['amqp', 'moray', 'redis']
    });

    var preconditionsNoVm = ensure({
        connectionTimeoutSeconds: 60 * 60,
        app: app,
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

    // Reprovision VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/reprovision',
            name: 'VmReprovision' },
        preconditionsGetVm,
        VM.reprovision);

    // List VMs
    http.get(
        { path: '/servers/:server_uuid/vms', name: 'VmList' },
        preconditionsNoVm,
        VM.list);

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
        { path: '/servers/:server_uuid/vms/:uuid/nop', name: 'DoNop' },
        preconditionsGetVm, VM.nop);
}

exports.attachTo = attachTo;
