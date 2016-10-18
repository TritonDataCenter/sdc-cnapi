/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * HTTP endpoints for interacting with virtual machines.
 */

var restify = require('restify');
var restifyClients = require('triton-tracer').restifyClient;
var sprintf = require('sprintf').sprintf;
var url = require('url');
var dns = require('dns');
var async = require('async');
var VError = require('verror');
var sdcClients = require('sdc-clients');

var validation = require('../validation/endpoints');
var migrationValidation = require('../validation/migration');
var errors = require('../errors');
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
 * @param {Object} error - An Error Object
 * @returns {object} Error Object
 *
 */
function errDetails(error) {
    var details;

    details = error.cause() && error.cause().body && error.cause().body.details;
    if (!details) {
        details = {};
    }

    return (details);
}


/**
 * (DEPRECATED: use VMAPI instead)
 *
 * Query the server for a list of VMs.
 *
 * @name VmList
 * @endpoint GET /servers/:server_uuid/vms
 * @section Virtual Machine API
 *
 * @response 204 Array List of VMs
 * @response 404 Object No such server
 */

VM.list = function handlerVmList(req, res, next) {
    ModelVM.listVmsViaVmapi({
        server_uuid: req.params.server_uuid
    }, function (err, vms) {
        if (err) {
            next(err);
            return;
        }
        res.send(200, vms);
        next();
    });
};

/**
 *
 * Query the server for the VM's details.
 *
 * @name VmLoad
 * @endpoint GET /servers/:server_uuid/vms/:uuid
 * @section Virtual Machine API
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 204 Object Task was sent to server
 * @response 404 Object No such VM
 * @response 404 Object No such server
 */

var vmLoadTimeoutSeconds = 60;
VM.load = function handlerVmLoad(req, res, next) {
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
        { req_id: req.getId(), req: req },
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
                if (errDetails(error).restCode === 'VmNotFound') {
                    next(new restify.ResourceNotFoundError('VM ' +
                        req.params.uuid + ' not found'));
                } else {
                    next(new restify.InternalError(error.message));
                }
                return;
            }
            res.send(vm);
            next();
            return;
        });
};


/*
 * NOT DOCUMENTED because not yet supported.
 */
var vmProcTimeoutSeconds = 20;
VM.proc = function handlerVmProc(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for machine_proc request to return'));
    }, vmProcTimeoutSeconds * 1000);

    req.stash.vm.proc(
        { req_id: req.getId(), req: req },
        function (error, procResponse) {
            clearTimeout(timeout);

            req.log.info({response: procResponse}, 'response');

            if (responded && error) {
                req.log.error(error.message);
                return;
            }

            if (responded) {
                req.log.warn('Got a reply back from an expired request');
                return;
            }

            if (error) {
                if (errDetails(error).restCode === 'VmNotFound') {
                    next(new restify.ResourceNotFoundError('VM ' +
                        req.params.uuid + ' not found'));
                } else {
                    next(new restify.InternalError(error.message));
                }
                return;
            }

            res.send(procResponse);
            next();
            return;
        });
};


/**
 * Query the server for the VM's `vmadm info` output.
 *
 * @name VmInfo
 * @endpoint GET /servers/:server_uuid/vms/:uuid/info
 * @section Virtual Machine API
 *
 * @response 200 Object Request succeeded
 * @response 404 Object No such VM
 * @response 404 Object No such server
 */

var vmInfoTimeoutSeconds = 10;
VM.info = function handlerVmInfo(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for machine_load request to return'));
    }, vmInfoTimeoutSeconds * 1000);

    var types;
    if (typeof (req.params.info) !== 'string') {
        types = ['all'];
    } else {
        types = req.params.info.split(',');
    }

    req.stash.vm.info(
        { req_id: req.getId(), types: types },
        function (error, infoResponse) {
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
                if (errDetails(error).restCode === 'VmNotFound') {
                    next(new restify.ResourceNotFoundError('VM ' +
                        req.params.uuid + ' not found'));
                } else {
                    next(new restify.InternalError(error.message));
                }
                return;
            }
            res.send(infoResponse);
            next();
            return;
        });
};



/**
 * Query the server for the VM's VNC host and port.
 *
 * @name VmInfo
 * @endpoint GET /servers/:server_uuid/vms/:uuid/vnc
 * @section Virtual Machine API
 *
 * @response 200 Object Request succeeded
 * @response 404 Object No such VM
 * @response 404 Object No such server
 */

var vmVNCTimeoutSeconds = 10;
VM.vnc = function handlerVmVnc(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for machine_load request to return'));
    }, vmVNCTimeoutSeconds * 1000);

    var types = ['vnc'];

    req.stash.vm.info(
        { req_id: req.getId(), types: types },
        function (error, infoResponse) {
            var vminfo;
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
                if (errDetails(error).restCode === 'VmNotFound') {
                    next(new restify.ResourceNotFoundError('VM ' +
                        req.params.uuid + ' not found'));
                } else {
                    next(new restify.InternalError(error.message));
                }
                return;
            }

            try {
                vminfo = JSON.parse(infoResponse);
            } catch (e) {
                req.log.error({infoResponse: infoResponse, err: e},
                    'failed to parse JSON');
                next(new restify.InternalError(
                    'failed to parse JSON response from vm.info'));
                return;
            }

            var host = vminfo.vnc.host;
            var port = vminfo.vnc.port;

            res.send({host: host, port:port});
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
 * @section Virtual Machine API
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

VM.update = function handlerVmUpdate(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_update', true, req, res, next);
};


/**
 * Bulk modify VM nics
 *
 * @name VmNicsUpdate
 * @endpoint POST /servers/:server\_uuid/vms/nics/update
 * @section Virtual Machine API
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 400 Error Task not supported on server
 * @response 404 Error No such server
 *
 */

VM.nicsUpdate = function handlerVmNicsUpdate(req, res, next) {
    var sysinfo = req.stash.server.value.sysinfo;

    // We don't support bulk updating of nics on 6.5
    if (!sysinfo.hasOwnProperty('SDC Version')) {
        next(new restify.InvalidVersionError(
            'Unsupported compute node version'));
        return;
    }

    // No req.stash.vm for this task, so we can't use performVmTask():
    req.stash.server.sendTaskRequest({
        log: req.log,
        task: 'machine_update_nics',
        params: req.params,
        req_id: req.getId(),
        cb: function (error, task) {
            res.send({ id: task.id });
            return next();
        }});
};


/**
 * Boot up a vm which is in the 'stopped' state.
 *
 * @name VmStart
 * @endpoint POST /servers/:server_uuid/vms/:uuid/start
 * @section Virtual Machine API
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/start
 */

VM.start = function handlerVmStart(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    if (validation.assert.updateLimitedToInternalMetadata(req, res, 'start')) {
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
 * @section Virtual Machine API
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

VM.stop = function handlerVmStop(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_shutdown', true, req, res, next);
};


/*
 * Send a signal to a given VM.
 *
 * @name VmKill
 * @endpoint POST /servers/:server_uuid/vms/:uuid/kill
 * @section Virtual Machine API
 *
 * @param {String} jobid Post information to workflow with this id
 * @param {String} signal Optional: Signal to send to init process of VM
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/:uuid/kill
 */

VM.kill = function handlerVmKill(req, res, next) {
    var killValidationRules = {
        'jobid': ['optional', 'isStringType'],
        'uuid': ['isStringType', 'isTrim'],
        'signal': ['optional', 'isNumberOrStringType']
    };

    if (validation.ensureParamsValid(req, res, killValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask('machine_kill', true, req, res, next);
};


/**
 * Reboot a VM which is in the 'running' state.
 *
 * @name VmReboot
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/reboot
 * @section Virtual Machine API
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

VM.reboot = function handlerVmReboot(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    if (validation.assert.updateLimitedToInternalMetadata(req, res, 'reboot')) {
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
 * @section Virtual Machine API
 *
 * @param {String} jobid Create a new virtual machine on the given server
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms
 */

VM.create = function handlerVmCreate(req, res, next) {
    var sysinfo;
    var sdc_version;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    // To support 6.5.* compute nodes
    // http://$IMGAPI_IP/images/$IMAGE_UUID/file
    var imgapi_url = req.stash.app.config.imgapi.url;
    var image_uuid;

    if (['bhyve', 'kvm'].indexOf(req.params.brand) !== -1) {
        if (req.params.hasOwnProperty('disks') && req.params.disks[0]) {
            image_uuid = req.params.disks[0].image_uuid;
        }
    } else {
        image_uuid = req.params.image_uuid;
    }

    if (typeof (image_uuid) !== 'string') {
        throw new Error('invalid image_uuid: ' + JSON.stringify(image_uuid)
            + ' (type: ' + typeof (image_uuid) + ')');
    }

    if (!req.params.image ||
        !req.params.image.files ||
        !req.params.image.files.length)
    {
        throw new Error(
            'missing required parameter images.files');
    }

    // Use sysinfo to determine whether CN is 7.0 or 6.5.
    sysinfo = req.stash.server.value.sysinfo;
    if (sysinfo.hasOwnProperty('SDC Version')) {
        sdc_version = Number(sysinfo['SDC Version']);
    } else {
        sdc_version = 6.5;
    }

    req.log.debug('CN sdc_version: ' + sdc_version);

    // On 6.5 CNs we need to add the default_gateway property so that VMs get
    // the proper gateway.
    if (sdc_version < 7.0 && req.params.hasOwnProperty('nics')) {
        req.params.nics.forEach(function (n) {
            if (n.primary && n.hasOwnProperty('gateway')) {
                req.log.debug('adding default_gateway for: '
                    + JSON.stringify(n, null, 2));
                req.params['default_gateway'] = n.gateway;
            }
        });
    }


    var parts = url.parse(imgapi_url);
    var hostname = parts.hostname;
    delete parts.host;

    // Check if the req.params.image contains an 'origin' property, and if it
    // does we need to send 'dataset_origin_url', 'dataset_origin_uuid' and
    // 'dataset_origin_url_compression'. This means fetching the origin image's
    // manifest from imgapi (to get the compression method).

    async.waterfall([
        function (cb) {
            // Resolve the imgapi address on cn-agent's behalf.
            dns.resolve(hostname, function (error, addrs) {
                if (error) {
                    cb(new VError(error,
                         'failed to resolve imgapi address %s', hostname));
                    return;
                }

                // Select a random address from the list.
                hostname = addrs[Math.floor(Math.random() * addrs.length)];
                parts.hostname = hostname;

                cb();
            });
        },
        function (cb) {
            // Check if the vm image specifies an origin dataset. If it doesn't
            // skip this part. If it does, send the imgapi url for the origin
            // to cn-agent.

            if (!req.params.image || !req.params.image.origin) {
                cb();
                return;
            }

            var originUuid
                = req.params.dataset_origin_uuid
                = req.params.image.origin;

            getManifest(imgapi_url, originUuid, function (err, manifest) {
                if (err) {
                    cb(new VError(err,
                        'failed to fetch origin manifest'));
                    return;
                }

                req.params.origin = manifest;

                parts.pathname = sprintf('/images/%s/file', originUuid);
                req.params.dataset_origin_url = url.format(parts);

                req.params.dataset_origin_url_compression
                    = manifest.files[0].compression;

                req.log.info({ manifest: manifest }, 'The origin manifest');
                cb();
            });
        },
        function (cb) {
            parts.pathname = sprintf('/images/%s/file', image_uuid);

            req.params.dataset_url_compression
                = req.params.image.files[0].compression;
            req.params.dataset_url = url.format(parts);
            cb();
        }
    ],
    function (error) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        var vm = req.stash.server.getVM(req.params.uuid);
        vm.performVmTask('machine_create', false, req, res, next, synccb);
    });

    function synccb(syncerr, result) {
        if (!syncerr) {
            req.log.info('no error provisioning vm %s on server %s',
                          req.params.uuid,
                          req.params.server_uuid);
            return;
        }
    }

    function getManifest(imgapiUrl, originUuid, cb) {
        var imagepath = sprintf('/images/%s', originUuid);

        var clienturl = url.format(parts);

        var client = restifyClients.createJsonClient({
            url: clienturl,
            version: '*',
            log: req.log,
            userAgent: false
        });

        client.get(imagepath, function (geterr, getreq, getres, getobj) {
            cb(geterr, getobj);
        });
    }
};


/*
 * Reprovision a given VM.
 *
 * @name VmReprovision
 * @endpoint POST /servers/:server_uuid/vms/:uuid/reprovision
 * @section Virtual Machine API
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

VM.reprovision = function handlerVmReprovision(req, res, next) {
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
 * @section Virtual Machine API
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example DELETE /servers/<server-uuid>/vms/<vm-uuid>
 */

VM.destroy = function handlerVmDestroy(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    req.stash.vm.performVmTask('machine_destroy', true, req, res, next);
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
 * @section Virtual Machine Snapshots API
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example PUT /servers/<server-uuid>/vms/:uuid/snapshots
 */

VmSnapshots.create = function handlerVmSnapshotsCreate(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask(
        'machine_create_snapshot', true, req, res, next);
};

/* BEGIN JSSTYLED */
/**
 * Roll back to a previous snapshot of a VM.
 *
 * @name VmSnapshotRollback
 * @endpoint PUT /servers/:server_uuid/vms/:uuid/snapshots/:snapshot_name/rollback
 * @section Virtual Machine Snapshots API
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example PUT /servers/<server-uuid>/vms/:uuid/snapshots
 */
/* END JSSTYLED */

VmSnapshots.rollback = function handlerVmSnapshotsRollback(req, res, next) {
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
 * @endpoint DELETE /servers/:server_uuid/vms/:uuid/snapshots/:snapshot_name
 * @section Virtual Machine Snapshots API
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example DELETE /servers/<server-uuid>/vms/:uuid/snapshots/:snapshot_name
 */
VmSnapshots.destroy = function handlerVmSnapshotsDestroy(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }
    req.stash.vm.performVmTask(
        'machine_delete_snapshot', true, req, res, next);
};

function VmImages() {}

/**
 * Create a VM image.
 *
 * @name VmImagesCreate
 * @endpoint POST /servers/:server_uuid/vms/:uuid/images
 * @section Virtual Machine Images API
 *
 * @param {String} jobid Create a new virtual machine on the given server
 * @param {String} compression Compression to use for creating image
 * @param {String} imgapi_url Location of imgapi
 * @param {Boolean} incremental Make this an incremental image? Optional.
 *      Default is false.
 * @param {String} prepare_image_script A script run in a reboot of the VM
 *      to prepare it for imaging.
 * @param {Object} manifest Image manifest object. Require at least "uuid",
 *      "owner", "name" and "version" keys. See "imgadm create"
 *      documentation for other required and optional fields.
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 */

VmImages.create = function handlerVmImagesCreate(req, res, next) {
    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var vmImagesCreateRules = {
        'jobid': [ ['optional', undefined], 'isStringType'],
        'compression': ['isStringType'],
        'imgapi_url': ['isStringType'],
        'incremental': [['optional', undefined], 'isBooleanType'],
        'prepare_image_script': [['optional', undefined], 'isStringType'],
        'manifest': ['isObjectType']
    };

    if (validation.ensureParamsValid(req, res, vmImagesCreateRules)) {
        next();
        return;
    }

    req.stash.vm.performVmTask(
        'machine_create_image', true, req, res, next);
};


/**
 * Send a docker_exec task to the given server/vm. This starts a server on the
 * given server which will spawn a process with the given docker payload.
 *
 * @name VmDockerExec
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/docker-exec
 * @section Virtual Machine API
 *
 * @param {String} address ip:port where the stdio server will be listening
 * @param {String} host host where the stdio server will be listening
 * @param {Number} port port on host the stdio server will be listening
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/docker-exec
 */

var vmDockerExecTimeoutSeconds = 60;
VM.dockerExec = function handlerVmDockerExec(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var vmDockerExecRules = {
        'command': ['isObjectType']
    };

    if (validation.ensureParamsValid(req, res, vmDockerExecRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for docker_exec request to return'));
    }, vmDockerExecTimeoutSeconds * 1000);

    req.stash.vm.dockerExec(
        { req_id: req.getId(), command: req.params.command },
        function (error, result) {
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
            res.send(result);
            next();
            return;
        });

};


/**
 * Send a docker_copy task to the given server/vm. This starts a temporary
 * service on the given server which will stream the the requested file.
 *
 * @name VmDockerCopy
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/docker-copy
 * @section Virtual Machine API
 *
 * @param {String} address ip:port where the stdio server will be listening
 * @param {String} host host where the stdio server will be listening
 * @param {Number} port port on host the stdio server will be listening
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/docker-exec
 */

var vmDockerCopyTimeoutSeconds = 10;
VM.dockerCopy = function handlerVmDockerCopy(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var vmDockerExecRules = {
    };

    if (validation.ensureParamsValid(req, res, vmDockerExecRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for docker_copy request to return'));
    }, vmDockerCopyTimeoutSeconds * 1000);

    var path = req.params.path;
    var mode = req.params.mode;

    // Older versions of CNAPI/sdc-docker passed parameters via a 'payload'
    // parameter, but this isn't necessary so its use is being phased out. We
    // should continue to be compatible with older version of the software for
    // a time.
    if (!path && req.params.payload) {
        path = req.params.payload.path;
        mode = req.params.payload.mode;
    }

    var copyOpts = {
        req_id: req.getId(),
        payload: req.params.payload,
        path: path,
        mode: mode
    };

    if (req.params.no_overwrite_dir) {
        copyOpts.no_overwrite_dir = true;
    }

    req.stash.vm.dockerCopy(copyOpts, function (error, result) {
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
            var details = errDetails(error);

            if (details.restCode === 'FileNotFound') {
                next(new errors.FileNotFoundError());
                return;
            }

            if (details.restCode === 'PathNotDirectory') {
                next(new errors.PathNotDirectoryError());
                return;
            }

            if (details.restCode === 'VmNotRunning') {
                next(new errors.VmNotRunningError());
                return;
            }

            if (details.restCode ===
                    'DockerCopyStoppedContainerNoPlatformSupport')
            {
                next(new
                    errors.DockerCopyStoppedContainerNoPlatformSupportError());
                return;
            }

            next(new restify.InternalError(error.message));
            return;
        }

        res.send(result);
        next();
        return;
    });
};


/**
 * Send a docker_stats task to the given server/vm. This starts a temporary
 * service on the given server which will stream back the container stats.
 *
 * @name VmDockerStats
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/docker-stats
 * @section Virtual Machine API
 *
 * @param {String} address ip:port where the stdio server will be listening
 * @param {String} host host where the stdio server will be listening
 * @param {Number} port port on host the stdio server will be listening
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such VM
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<vm-uuid>/docker-stats
 */

var vmDockerStatsTimeoutSeconds = 30;

VM.dockerStats = function handlerVmDockerStats(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for docker_stats request to return'));
    }, vmDockerStatsTimeoutSeconds * 1000);


    req.stash.vm.dockerStats(
        { req_id: req.getId(), payload: req.params.payload },
        function (error, result) {
            clearTimeout(timeout);

            if (responded && error) {
                req.log.error(error.message);
                return;
            }

            if (responded) {
                req.log.warn('Got a reply back from an expired request');
                return;
            }

            if (error && error.orig &&
                error.orig.error.match(new RegExp('^ENOENT,')))
            {
                next(new restify.ResourceNotFoundError(
                    'Could not find the file %s in container %s',
                    req.params.payload.Resource,
                    req.params.payload.id));
                return;
            }

            if (error) {
                next(new restify.InternalError(error.message));
                return;
            }
            res.send(result);
            next();
            return;
        });
};


/**
 * Send a docker_build task to the given server/vm. This starts a temporary
 * service on the given server which will allow streaming of the build context
 * to the server and then runs the docker build steps.
 *
 * @name VmDockerBuild
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/docker-build
 * @section Virtual Machine API
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<uuid>/docker-build
 */

var vmDockerBuildTimeoutSeconds = 30;

VM.dockerBuild = function handlerVmDockerBuild(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, vmValidationRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for docker_build request to return'));
    }, vmDockerBuildTimeoutSeconds * 1000);


    req.stash.vm.dockerBuild(
        { req_id: req.getId(), payload: req.params.payload, log_params: false },
        function (error, result) {
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
            res.send(result);
            next();
            return;
        });
};


/**
 * Start migrating the instance to a new server.
 *
 * @name VmMigrate
 * @endpoint POST /servers/:server\_uuid/vms/:uuid/migrate
 * @section Virtual Machine API
 *
 * @response 204 None Task was sent to server
 * @response 404 Error No such server
 * @response 500 Error Error encountered while attempting to fulfill request
 *
 * @example POST /servers/<server-uuid>/vms/<uuid>/migrate
 */

VM.migrate = function handlerVmMigrate(req, res, next) {
    if (!migrationValidation.validateReq(req, res)) {
        next();
        return;
    }

    req.stash.vm.performVmTask('machine_migrate', true, req, res, next);
};


function attachTo(http, app) {
    VM.init();

    var ensure = require('../endpoints').ensure;

    /**
     *
     * VM Snapshots
     *
     */

    // Create VM
    http.post(
        { path: '/servers/:server_uuid/vms', name: 'VmCreate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        VM.create);

    // Reprovision VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/reprovision',
            name: 'VmReprovision' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.reprovision);

    // List VMs
    http.get(
        { path: '/servers/:server_uuid/vms', name: 'VmList' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        VM.list);

    // Bulk update VM nics
    http.post(
        { path: '/servers/:server_uuid/vms/nics/update', name: 'VmNicsUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        VM.nicsUpdate);

    // Load VM's details from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'VmLoad' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.load);

    // Load VM's proc data output from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid/proc', name: 'VmProc' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.proc);

    // Load VM's vmadm info output from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid/info', name: 'VmInfo' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.info);

    // Load VM's vnc info output from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid/vnc', name: 'VmVnc' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.vnc);

    // Update VM's properties from the server (resize)
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/update', name: 'VmUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.update);

    // Start VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/start', name: 'VmStart' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.start);

    // Stop VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/stop', name: 'VmStop' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.stop);

    // Kill VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/kill', name: 'VmKill' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.kill);

    // Reboot VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/reboot', name: 'VmReboot' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.reboot);

    // Delete a VM
    http.del(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'VmDestroy' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.destroy);

    // Migrate VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/migrate',
            name: 'VmMigrate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.migrate);


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
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VmSnapshots.create);


    // Rollback VM to Snapshot
    http.put(
        {
            path: '/servers/:server_uuid'
                  + '/vms/:uuid/snapshots/:snapshot_name/rollback',
            name: 'VmSnapshotRollback'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VmSnapshots.rollback);

    // Destroy a VM snapshot
    http.del(
        {
            path: '/servers/:server_uuid'
                  + '/vms/:uuid/snapshots/:snapshot_name',
            name: 'VmSnapshotDestroy'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VmSnapshots.destroy);

    /**
     *
     * VM Images
     *
     */

    // Create VM Image
    http.post(
        {
            path: '/servers/:server_uuid/vms/:uuid/images',
            name: 'VmImageCreate'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VmImages.create);

    /**
     *
     * Docker
     *
     */

    // VM Docker Exec
    http.post(
        {
            path: '/servers/:server_uuid/vms/:uuid/docker-exec',
            name: 'VmDockerExec'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.dockerExec);

    // VM Docker Copy
    http.post(
        {
            path: '/servers/:server_uuid/vms/:uuid/docker-copy',
            name: 'VmDockerCopy'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.dockerCopy);

    // VM Docker Stats
    http.post(
        {
            path: '/servers/:server_uuid/vms/:uuid/docker-stats',
            name: 'VmDockerStats'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.dockerStats);

    // VM Docker Build
    http.post(
        {
            path: '/servers/:server_uuid/vms/:uuid/docker-build',
            name: 'VmDockerBuild'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            serverRunning: true,
            prepopulate: ['server', 'vm'],
            connected: ['moray']
        }),
        VM.dockerBuild);
}

exports.attachTo = attachTo;
