/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This file contains all the Image logic, used to communicate with the server
 * with the intent of getting information about installed images.
 */

var async = require('async');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var nodeuuid = require('node-uuid');

var ModelBase = require('./base');
var ModelServer;

var PROVISIONER = 'provisioner';

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
    var reqId;

    if (opts.reqId) {
        reqId = opts.reqId;
    } else {
        reqId = nodeuuid.v4();
    }

    ModelImage.getTaskClient().getAgentHandle(
        PROVISIONER,
        self.serverUuid,
        function (handle) {

            handle.sendTask(
                'image_get',
                { uuid: self.uuid, req_id: reqId },
                function (taskHandle) {
                    if (!taskHandle) {
                        callback(new Error('hit max tasks limit'));
                        return;
                    }
                    var error;

                    taskHandle.on('event', function (eventName, msg) {
                        if (eventName === 'error') {
                            self.log.error(
                                'Error received during imaeg get: %s',
                                msg.error);
                            error = msg.error;
                        } else if (eventName === 'finish') {
                            if (error) {
                                callback(new Error(error));
                                return;
                            } else {
                                callback(null, msg);
                                return;
                            }
                        }
                    });
                });
        });
};

module.exports = ModelImage;
