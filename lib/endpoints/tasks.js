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
 * @section Compute Node Agent Tasks API
 *
 * @example GET /tasks/a1b2c3d4
 *
 * @response 200 Object Task details
 * @response 404 None No such task found
 */

Task.get = function (req, res, next) {
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


/**
 * Waits for a given task to return or an expiry to be reached.
 *
 * @name TaskWait
 * @endpoint GET /tasks/:task_id/wait
 * @section Compute Node Agent Tasks API
 *
 * @example GET /tasks/a1b2c3d4
 *
 * @response 200 Object Task details
 * @response 404 None No such task found
 */

Task.wait = function (req, res, next) {
    var value;
    var waitError;

    // Try to get task in moray. If it's complete, just return it.
    // If task is not complete, wait for it to return or timeout.
    // Check task after waiting, return whatever we have.

    get(function (val) {
        wait(function () {
            get(function () {
                res.send(value);
                next();
            });
        });
    });

    function get(cb) {
        ModelServer.getMoray().getObject(
            buckets.tasks.name,
            req.params.taskid,
            function (error, obj) {
                if (error && error.name === 'ObjectNotFoundError') {
                    next(new restify.ResourceNotFoundError(
                        'no such task found'));
                    return;
                } else if (error) {
                    next(new restify.InternalError(
                        'error fetching task from moray'));
                    return;
                }

                if (waitError) {
                    res.send(500, obj.value);
                    next();
                    return;
                }

                if (obj.value && obj.value.status === 'complete') {
                    res.send(obj.value);
                    next();
                    return;
                }
                value = obj.value;

                cb();
            });
    }

    function wait(cb) {
        ModelServer.getApp().waitForTask({
            taskid: req.params.taskid,
            timeoutSeconds: req.params.timeout &&
                parseInt(req.params.timeout, 10) || 3600
        }, function (err) {
            req.log.warn(err, 'done waiting');
            waitError = err;
            cb();
        });
    }
};

function attachTo(http, app) {
    var toModel = {
        app: app
    };

    // Get task details
    http.get(
        { path: '/tasks/:taskid', name: 'TaskGet' },
        Task.get.bind(toModel));

    // Get task details
    http.get(
        { path: '/tasks/:taskid/wait', name: 'TaskWait' },
        Task.wait.bind(toModel));
}

exports.attachTo = attachTo;
