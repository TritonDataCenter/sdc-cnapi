/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * fw.js: Endpoints to manage firewall rules and related data
 */

var common = require('../common');
var restify = require('restify');
var util = require('util');
var ModelServer = require('../models/server');

function createTaskCallback(req, res, next) {
    return function (error, task_id) {
        res.send({ id: task_id });
        return next();
    };
}

function FW() {}

FW.sendTask = function (name, req, res, next) {
    var self = this;
    var server = req.params.server;
    delete req.params.server;

    req.log.info({server: server.uuid, params: req.params},
        'send %s task', name);
    server.sendProvisionerTask(
        name,
        req.params,
        ModelServer.createProvisionerEventHandler(self, req.params.jobid),
        createTaskCallback(req, res, next));
};

FW.add = function (req, res, next) {
    FW.sendTask('fw_add', req, res, next);
};

FW.del = function (req, res, next) {
    FW.sendTask('fw_del', req, res, next);
};

FW.update = function (req, res, next) {
    FW.sendTask('fw_update', req, res, next);
};

function attachTo(http) {
    var before = [
        function (req, res, next) {
            if (!req.params.server_uuid) {
                next();
                return;
            }

            req.params.server = new ModelServer(req.params.server_uuid);
            req.params.server.getRaw(function (error, server) {
                // Check if any servers were returned
                if (!server) {
                    var errorMsg
                        = 'Server ' + req.params.server_uuid + ' not found';
                    next(
                        new restify.ResourceNotFoundError(errorMsg));
                    return;
                }
                next();
            });
        }
    ];

    // Add firewall data
    http.post(
        { path: '/servers/:server_uuid/fw/add', name: 'AddFw' },
        before, FW.add);

    // Delete firewall data
    http.post(
        { path: '/servers/:server_uuid/fw/del', name: 'DelFw' },
        before, FW.del);

    // Update firewall data
    http.post(
        { path: '/servers/:server_uuid/fw/update', name: 'UpdateFw' },
        before, FW.update);
}

exports.attachTo = attachTo;
