/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Client library for the SDC Networking API (ZAPI)
 */

var util = require('util');
var format = util.format;

var RestifyClient = require('./restifyclient');



///--- Exported Client


/**
 * Constructor
 *
 * See the RestifyClient constructor for details
 */
function ZAPI(options) {
  RestifyClient.call(this, options);
}

util.inherits(ZAPI, RestifyClient);


///--- Machine methods



/**
 * Lists all machines
 *
 * @param {Object} params : Filter params.
 * @param {Function} callback : of the form f(err, res).
 */
ZAPI.prototype.listMachines = function(params, callback) {
  if (typeof(params) === 'function') {
    callback = params;
    params = {};
  }
  return this.get("/machines", params, callback);
};



/**
 * Gets a machine by UUID
 *
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the machine.
 * @param {String} params.owner_uuid : Optional, the UUID of the machine.
 * @param {Function} callback : of the form f(err, res).
 */
ZAPI.prototype.getMachine = function(params, callback) {
  var query = {};

  if (!params || typeof(params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');
  if (params.owner_uuid)
    query.owner_uuid = params.owner_uuid

  return this.get(format("/machines/%s", params.uuid), query, callback);
};



/**
 * Creates a machine
 *
 * @param {Object} params : attributes of the machine.
 * @param {Function} callback : of the form f(err, res).
 */
ZAPI.prototype.createMachine = function(params, callback) {
  if (!params || typeof(params) !== 'object')
    throw new TypeError('params is required (object)');

  return this.post("/machines", params, callback);
};



/**
 * Stops a machine
 *
 * @param {String} uuid : the UUID of the machine.
 * @param {Function} callback : of the form f(err, res).
 */
ZAPI.prototype.stopMachine = function(params, callback) {
  var query = { action: 'stop' };

  if (!params || typeof(params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');
  if (params.owner_uuid)
    query.owner_uuid = params.owner_uuid

  return this.post(format("/machines/%s", params.uuid), query, callback);
};



/**
 * Starts a machine
 *
 * @param {String} uuid : the UUID of the machine.
 * @param {Function} callback : of the form f(err, res).
 */
ZAPI.prototype.startMachine = function(params, callback) {
  var query = { action: 'start' };

  if (!params || typeof(params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');
  if (params.owner_uuid)
    query.owner_uuid = params.owner_uuid

  return this.post(format("/machines/%s", params.uuid), query, callback);
};



/**
 * Reboots a machine
 *
 * @param {String} uuid : the UUID of the machine.
 * @param {Function} callback : of the form f(err, res).
 */
ZAPI.prototype.rebootMachine = function(params, callback) {
  var query = { action: 'reboot' };

  if (!params || typeof(params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');
  if (params.owner_uuid)
    query.owner_uuid = params.owner_uuid

  return this.post(format("/machines/%s", params.uuid), query, callback);
};



/**
 * Destroys a machine
 *
 * @param {String} uuid : the UUID of the machine.
 * @param {Function} callback : of the form f(err, res).
 */
ZAPI.prototype.deleteMachine = function(params, callback) {
  if (!params || typeof(params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');

  var path;

  if (params.owner_uuid)
    path = format("/machines/%s?owner_uuid=%s", params.uuid, params.owner_uuid);
  else
    path = format("/machines/%s", params.uuid)

  return this.del(path, callback);
};



module.exports = ZAPI;
