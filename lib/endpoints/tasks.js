/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');
var ModelServer = require('../models/server');
var buckets = require('../apis/moray').BUCKETS;

function Task() {}

/**
 * Returns the details of the given task.
 *
 * @name TaskGet
 * @endpoint GET /tasks/:task_id
 * @section Provisioner Tasks
 *
 * @example GET /tasks/a1b2c3d4
 *
 * @response 200 Object Task details
 * @response 404 None No such task found
 */

Task.get = function (req, res, next) {
    // check in moray
    ModelServer.getMoray().getObject(
        buckets.tasks.name,
        req.params.taskid,
        function (error, obj) {
            if (error && error.name === 'ObjectNotFoundError') {
                next(new restify.ResourceNotFoundError(
                    'no such task found'));
                return;
            } else if (error) {
                next(
                    new restify.InternalError(
                        'error fetching task from moray'));
                return;
            }
            res.send(obj.value);
            next();
            return;
        });
};

function attachTo(http, app) {
    var toModel = {
        app: app
    };

    // Get task details
    http.get(
        { path: '/tasks/:taskid', name: 'TaskGet' },
        Task.get.bind(toModel));
}

exports.attachTo = attachTo;
