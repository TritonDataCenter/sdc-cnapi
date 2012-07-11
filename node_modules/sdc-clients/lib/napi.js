/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Client library for the SDC Networking API (NAPI)
 */

var util = require('util');
var format = util.format;

var RestifyClient = require('./restifyclient');



// --- Exported Client


/**
 * Constructor
 *
 * See the RestifyClient constructor for details
 */
function NAPI(options) {
    RestifyClient.call(this, options);
}

util.inherits(NAPI, RestifyClient);


/**
 * Ping NAPI server.
 *
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.ping = function (callback) {
    return this.get('/ping', callback);
};



// --- Nic methods



/**
 * Lists all Nics
 *
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.listNics = function (params, callback) {
    return this.get('/nics', params, callback);
};


/**
 * Gets a Nic by MAC address.
 *
 * @param {String} macAddr : the MAC address.
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.getNic = function (macAddr, callback) {
    if (!macAddr)
        throw new TypeError('macAddr is required (string)');
    return this.get(format('/nics/%s', macAddr.replace(/:/g, '')), callback);
};


/**
 * Updates the Nic specified by MAC address.
 *
 * @param {String} macAddr : the MAC address.
 * @param {Object} params : the parameters to update.
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.updateNic = function (macAddr, params, callback) {
    if (!macAddr)
        throw new TypeError('macAddr is required (string)');
    return this.put(format('/nics/%s', macAddr.replace(/:/g, '')),
        params, callback);
};


/**
 * Gets the nics for the given owner
 *
 * @param {String} belongsTo : the UUID that the nics belong to
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.getNics = function (belongsTo, callback) {
    if (!belongsTo)
        throw new TypeError('belongsTo is required (string)');
    return this.listNics({ belongs_to_uuid: belongsTo }, callback);
};


/**
 * Creates a Nic
 *
 * @param {String} macAddr : the MAC address.
 * @param {Object} params : the parameters to update.
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.createNic = function (macAddr, params, callback) {
    if (!macAddr)
        throw new TypeError('macAddr is required (string)');
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');

    params.mac = macAddr;

    return this.post('/nics', params, callback);
};


/**
 * Provisions a new Nic, with an IP address on the given logical network
 *
 * @param {String} network : the logical network to create this nic on
 * @param {Object} params : the parameters to update.
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.provisionNic = function (network, params, callback) {
    if (!network)
        throw new TypeError('network is required (string)');
    return this.post(format('/networks/%s/nics', network), params, callback);
};


/**
 * Deletes the Nic specified by MAC address.
 *
 * @param {String} macAddr : the MAC address.
 * @param {Object} params : the parameters to update.
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.deleteNic = function (macAddr, params, callback) {
    if (!macAddr)
        throw new TypeError('macAddr is required (string)');
    return this.del(format('/nics/%s', macAddr.replace(/:/g, '')),
        params, callback);
};



// --- Network methods



/**
 * Lists all Networks
 *
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.listNetworks = function (params, callback) {
    return this.get('/networks', params, callback);
};


/**
 * Lists the IPs for the given logical network
 *
 * @param {String} network : the logical network to list IPs on
 * @param {Object} params : the parameters to pass
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.listIPs = function (network, params, callback) {
    if (!network)
        throw new TypeError('network is required (string)');
    return this.get(format('/networks/%s/ips', network), params, callback);
};


/**
 * Gets an IP on the given logical network
 *
 * @param {String} network : the logical network that the IP is on
 * @param {String} ipAddr : the IP address to get info for
 * @param {Object} params : the parameters to pass
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.getIP = function (network, ipAddr, params, callback) {
    if (!network)
        throw new TypeError('network is required (string)');
    if (!ipAddr)
        throw new TypeError('ip address is required (string)');
    return this.get(
        format('/networks/%s/ips/%s', network, ipAddr), params, callback);
};


/**
 * Updates an IP on the given logical network
 *
 * @param {String} network : the logical network the IP is on
 * @param {String} ipAddr : the address of the IP to update
 * @param {Object} params : the parameters to update
 * @param {Function} callback : of the form f(err, res).
 */
NAPI.prototype.updateIP = function (network, ipAddr, params, callback) {
    if (!network)
        throw new TypeError('network is required (string)');
    if (!ipAddr)
        throw new TypeError('ip address is required (string)');
    if (!params)
        throw new TypeError('params is required (object)');
    return this.put(
        format('/networks/%s/ips/%s', network, ipAddr), params, callback);
};


module.exports = NAPI;
