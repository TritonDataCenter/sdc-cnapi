/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Client library for the SDC Networking API (VMAPI)
 */

var util = require('util');
var format = util.format;

var RestifyClient = require('./restifyclient');
var METADATA_TYPES = ['customer_metadata', 'internal_metadata', 'tags'];


// --- Exported Client


/**
 * Constructor
 *
 * See the RestifyClient constructor for details
 */
function VMAPI(options) {
    RestifyClient.call(this, options);
}

util.inherits(VMAPI, RestifyClient);


// --- Vm methods



/**
 * Lists all VMs
 *
 * @param {Object} params : Filter params.
 * @param {Function} callback : of the form f(err, vms).
 */
VMAPI.prototype.listVms = function (params, callback) {
    if (typeof (params) === 'function') {
        callback = params;
        params = {};
    }
    return this.get('/vms', params, callback);
};



/**
 * Gets a VM by UUID and/or owner
 *
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the VM.
 * @param {String} params.owner_uuid : Optional, the owner of the VM.
 * @param {Function} callback : of the form f(err, vm).
 */
VMAPI.prototype.getVm = function (params, callback) {
    var query = {};

    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');
    if (params.owner_uuid)
        query.owner_uuid = params.owner_uuid;

    return this.get(format('/vms/%s', params.uuid), query, callback);
};



/**
 * Creates a VM. Returns a Job Response Object
 *
 * @param {Object} params : attributes of the VM.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.createVm = function (params, callback) {
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');

    return this.post('/vms', params, callback);
};



/**
 * Stops a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.stopVm = function (params, callback) {
    var query = { action: 'stop' };

    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');
    if (params.owner_uuid)
        query.owner_uuid = params.owner_uuid;

    return this.post(format('/vms/%s', params.uuid), query, callback);
};



/**
 * Starts a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.startVm = function (params, callback) {
    var query = { action: 'start' };

    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');
    if (params.owner_uuid)
        query.owner_uuid = params.owner_uuid;

    return this.post(format('/vms/%s', params.uuid), query, callback);
};



/**
 * Reboots a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.rebootVm = function (params, callback) {
    var query = { action: 'reboot' };

    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');
    if (params.owner_uuid)
        query.owner_uuid = params.owner_uuid;

    return this.post(format('/vms/%s', params.uuid), query, callback);
};



/**
 * Updates a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.updateVm = function (params, callback) {
    var uuid;

    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');

    params.action = 'update';
    uuid = params.uuid;
    delete params.uuid;

    return this.post(format('/vms/%s', uuid), params, callback);
};



/**
 * Destroys a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.deleteVm = function (params, callback) {
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');

    var path;

    if (params.owner_uuid)
        path = format('/vms/%s?owner_uuid=%s', params.uuid, params.owner_uuid);
    else
        path = format('/vms/%s', params.uuid);

    return this.del(path, callback);
};



/**
 * Lists metadata for a VM
 *
 * @param {String} type : the metadata type, can be 'customer_metadata',
 *        'internal_metadata' or 'tags'.
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the VM.
 * @param {String} params.owner_uuid : Optional, the owner of the VM.
 * @param {Function} callback : of the form f(err, metadata).
 */
VMAPI.prototype.listMetadata = function (type, params, callback) {
    var query = {};

    if (!type || typeof (type) !== 'string' ||
        (METADATA_TYPES.indexOf(type) == -1))
        throw new TypeError('type is required (string)');
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');
    if (params.owner_uuid)
        query.owner_uuid = params.owner_uuid;

    return this.get(format('/vms/%s/%s', params.uuid, type), query, callback);
};



/**
 * Gets the metadata value for a key on the given VM
 *
 * @param {String} type : the metadata type, can be 'customer_metadata',
 *        'internal_metadata' or 'tags'.
 * @param {String} key : Metadata key.
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the VM.
 * @param {String} params.owner_uuid : Optional, the owner of the VM.
 * @param {Function} callback : of the form f(err, metadata).
 */
VMAPI.prototype.getMetadata = function (type, key, params, callback) {
    var query = {};

    if (!type || typeof (type) !== 'string' ||
        (METADATA_TYPES.indexOf(type) == -1))
        throw new TypeError('type is required (string)');
    if (!key || typeof (key) !== 'string')
        throw new TypeError('key is required (string)');
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');
    if (params.owner_uuid)
        query.owner_uuid = params.owner_uuid;

    return this.get(format('/vms/%s/%s/%s', params.uuid, type, key),
                    query, callback);
};



/**
 * Adds (appends) metadata to a VM
 *
 * @param {String} type : the metadata type, can be 'customer_metadata',
 *      'internal_metadata' or 'tags'.
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the VM.
 * @param {String} params.owner_uuid : Optional, the owner of the VM.
 * @param {Object} params.<key> : Additional keys are used as metadata.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.addMetadata = function (type, params, callback) {
    var uuid;

    if (!type || typeof (type) !== 'string' ||
        (METADATA_TYPES.indexOf(type) == -1))
        throw new TypeError('type is required (string)');
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');

    uuid = params.uuid;
    delete params.uuid;

    return this.post(format('/vms/%s/%s', uuid, type), params, callback);
};



/**
 * Sets (replaces) new metadata for a VM
 *
 * @param {String} type : the metadata type, can be 'customer_metadata',
 *      'internal_metadata' or 'tags'.
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the VM.
 * @param {String} params.owner_uuid : Optional, the owner of the VM.
 * @param {Object} params.<key> : Additional keys are used as metadata.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.setMetadata = function (type, params, callback) {
    var uuid;

    if (!type || typeof (type) !== 'string' ||
        (METADATA_TYPES.indexOf(type) == -1))
        throw new TypeError('type is required (string)');
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');

    uuid = params.uuid;
    delete params.uuid;

    return this.put(format('/vms/%s/%s', uuid, type), params, callback);
};



/**
 * Deletes a metadata key from a VM
 *
 * @param {String} type : the metadata type, can be 'customer_metadata',
 *      'internal_metadata' or 'tags'.
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the VM.
 * @param {String} params.owner_uuid : Optional, the owner of the VM.
 * @param {Object} key : Metadata key to be deleted.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.deleteMetadata = function (type, params, key, callback) {
    var query = {};

    if (!type || typeof (type) !== 'string' ||
        (METADATA_TYPES.indexOf(type) == -1))
        throw new TypeError('type is required (string)');
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');
    if (!key)
        throw new TypeError('Metadata \'key\' is required');
    if (params.owner_uuid)
        query.owner_uuid = params.owner_uuid;

    return this.del(format('/vms/%s/%s/%s', params.uuid, type, key),
                    query, callback);
};



/**
 * Deletes ALL metadata from a VM
 *
 * @param {String} type : the metadata type, can be 'customer_metadata',
 *      'internal_metadata' or 'tags'.
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the VM.
 * @param {String} params.owner_uuid : Optional, the owner of the VM.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.deleteAllMetadata = function (type, params, callback) {
    var query = {};

    if (!type || typeof (type) !== 'string' ||
        (METADATA_TYPES.indexOf(type) == -1))
        throw new TypeError('type is required (string)');
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.uuid)
        throw new TypeError('UUID is required');
    if (params.owner_uuid)
        query.owner_uuid = params.owner_uuid;

    return this.del(format('/vms/%s/%s', params.uuid, type), query, callback);
};



/**
 * Lists all Jobs
 *
 * @param {Object} params : Filter params.
 * @param {String} params.task : the job task type.
 * @param {String} params.vm_uuid : the UUID of the VM.
 * @param {String} params.execution : the job execution state.
 * @param {Function} callback : of the form f(err, jobs).
 */
VMAPI.prototype.listJobs = function (params, callback) {
    if (typeof (params) === 'function') {
        callback = params;
        params = {};
    }
    return this.get('/jobs', params, callback);
};



/**
 * Gets a Job by UUID
 *
 * @param {String} uuid : the UUID of the Job.
 * @param {Function} callback : of the form f(err, job).
 */
VMAPI.prototype.getJob = function (uuid, callback) {
    if (!uuid)
        throw new TypeError('UUID is required');

    return this.get(format('/jobs/%s', uuid), callback);
};


module.exports = VMAPI;
