/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This file contains all the Image logic, used to communicate with the server
 * with the intent of getting information about installed images.
 */

var assert = require('assert-plus');
var async = require('async');
var sprintf = require('sprintf').sprintf;
var util = require('util');

var ModelBase = require('./base');
var ModelServer;

function ModelImage(params) {
    var serverUuid = params.serverUuid;
    var uuid = params.uuid;

    if (!serverUuid) {
        throw new Error('ModelImage missing server_uuid parameter');
    }

    if (!uuid) {
        throw new Error('ModelImage missing uuid parameter');
    }

    this.uuid = uuid;
    this.serverUuid = serverUuid;

    this.log = ModelImage.getLog();
}

ModelImage.init = function (app) {
    ModelServer = require('./server');
    this.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelImage[p] = ModelBase.staticFn[p];
    });

    ModelImage.log = app.getLog();
};


/**
 * Look up an Image's information via a provsioner task. (Synchronous, does not
 * return until request completes.)
 */
ModelImage.prototype.get = function (opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.uuid(opts.req_id, 'opts.req_id');

    ModelServer.get(self.serverUuid, function (err, servermodel, server) {
        var request = {
            task: 'image_get',
            cb: function (error, task) {
            },
            evcb: function () {},
            synccb: function (error, result) {
                callback(error, result);
            },
            req_id: opts.req_id,
            params: { uuid: self.uuid }
        };

        servermodel.sendTaskRequest(request);
    });
};

module.exports = ModelImage;
