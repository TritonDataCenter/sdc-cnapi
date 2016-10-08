/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * HTTP endpoints for interacting with images.
 */

var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var url = require('url');
var dns = require('dns');
var async = require('async');
var verror = require('verror');

var validation = require('../validation/endpoints');
var ModelServer = require('../models/server');
var ModelImage = require('../models/image');

function Image() {}

Image.init = function () {
    Image.log = ModelImage.log;
};

var imageValidationRules = {
    'jobid': ['optional', 'isStringType'],
    'uuid': ['isStringType']
};


var imageLoadTimeoutSeconds = 60;

/**
 * Query the server for the Image's details.
 *
 * @name ImageGet
 * @endpoint GET /servers/:server_uuid/images/:uuid
 * @section Miscellaneous API
 *
 * @param {String} jobid Post information to workflow with this id
 *
 * @response 200 Object Request succeeded
 * @response 404 Object No such Image
 * @response 404 Object No such server
 */

Image.get = function get(req, res, next) {
    var responded;

    if (validation.ensureParamsValid(req, res, imageValidationRules)) {
        next();
        return;
    }

    var timeout = setTimeout(function () {
        responded = true;
        next(new restify.InternalError(
            'Time-out reached waiting for image_get request to return'));
    }, imageLoadTimeoutSeconds * 1000);

    req.stash.image.get(
        { req: req, reqId: req.getId() },
        function (error, image) {
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
            res.send(image);
            next();
            return;
        });
};


function attachTo(http, app) {
    Image.init();

    var ensure = require('../endpoints').ensure;

    /**
     *
     * Images
     *
     */

    // Load Image's details from the server
    http.get(
        { path: '/servers/:server_uuid/images/:uuid', name: 'ImageGet' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server', 'image'],
            connected: ['moray']
        }),
        Image.get);
}

exports.attachTo = attachTo;
