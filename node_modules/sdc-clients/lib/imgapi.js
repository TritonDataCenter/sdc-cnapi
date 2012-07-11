/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Client library for the SDC Image API (IMGAPI)
 */

var util = require('util'),
    format = util.format,
    restify = require('restify'),
    qs = require('querystring');

function IMGAPI(options) {
    if (typeof (options) !== 'object') {
        throw new TypeError('options (Object) required');
    }

    if (typeof (options.url) !== 'string') {
        throw new TypeError('options.url (String) required');
    }

    this.client = restify.createJsonClient(options);

    if (options.username && options.password) {
        this.client.basicAuth(options.username, options.password);
    }
}

/**
 * Lists all Images
 *
 * @param {Object} params : Filter params. Images can be filtered by
 *                          'name', 'version', 'type', 'os',
 *                          'restricted_to_uuid' & 'creator_uuid' params.
 * @param {Function} callback : of the form f(err, imgs).
 */
IMGAPI.prototype.listImages = function (params, cb) {
    var self = this,
        path = '/datasets';

    if (typeof (params) === 'function') {
        cb = params;
        params = {};
    } else if (typeof (params) !== 'object') {
        throw new TypeError('params (Object) required');
    }

    params = qs.stringify(params);

    if (params !== '') {
        path += '?' + params;
    }

    return self.client.get(path, function (err, req, res, imgs) {
        if (err) {
            return cb(err);
        } else {
            return cb(null, imgs);
        }
    });
};


/**
 * Gets an IMAGE by UUID
 *
 * @param {String} image_uuid : the UUID of the IMAGE.
 * @param {Function} callback : of the form f(err, img).
 */
IMGAPI.prototype.getImage = function (image_uuid, cb) {
    var self = this,
        path;

    if (typeof (image_uuid) !== 'string') {
        throw new TypeError('image_uuid (String) required');
    }

    path = format('/datasets/%s', image_uuid);

    return self.client.get(path, function (err, req, res, img) {
        if (err) {
            return cb(err);
        } else {
            return cb(null, img);
        }
    });
};

module.exports = IMGAPI;
