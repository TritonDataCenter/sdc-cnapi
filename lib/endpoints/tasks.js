/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');
var async = require('async');
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
    var task;

    get(function (val) {
        if (task.status === 'complete' || task.status === 'failure') {
            res.send(200, task);
            next();
            return;
        }

        wait(function () {
            get(function () {
                res.send(200, task);
                next();
            });
        });
    });

    function get(cb) {
        ModelServer.getMoray().getObject(
            buckets.tasks.name,
            req.params.taskid,
            { noCache: true },
            function (err, obj) {
                if (err && err.name === 'ObjectNotFoundError') {
                    next(new restify.ResourceNotFoundError(
                        'no such task found'));
                    return;
                } else if (err) {
                    next(new restify.InternalError(
                        'error fetching task from moray'));
                    return;
                }

                task = obj.value;

                cb();
            });
    }

    function wait(cb) {
        ModelServer.getApp().waitForTask({
            taskid: req.params.taskid,
            timeoutSeconds: req.params.timeout &&
                parseInt(req.params.timeout, 10) || 3600
        }, function (err, mytask) {
            if (err) {
                cb();
                return;
            }

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

    // Wait on a particular task to complete
    http.get(
        { path: '/tasks/:taskid/wait', name: 'TaskWait' },
        Task.wait.bind(toModel));
}

exports.attachTo = attachTo;
