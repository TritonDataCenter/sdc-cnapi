/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var restify = require('restify');
var async = require('async');
var VError = require('verror');
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

Task.get = function handlerTaskGet(req, res, next) {
    ModelServer.getMoray().getObject(
        buckets.tasks.name,
        req.params.taskid,
        function (error, obj) {
            if (error && VError.hasCauseWithName(error,
                                                 'ObjectNotFoundError'))
            {
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

Task.wait = function handlerTaskWait(req, res, next) {
    var task;

    req.log.debug('handlerTaskWait: starting to wait');

    get(function (val) {
        if (task.status === 'complete' || task.status === 'failure') {
            req.log.debug({ task: task }, 'handlerTaskWait: got task',
                req.params.taskid, task.status);
            res.send(200, task);
            next();
            return;
        }

        req.log.debug(
            'handlerTaskWait: task not complete nor failure, waiting on task');

        /**
         * CNAPI conflates unsuccessful cn-agent task execution attempts with
         * other types of non-task related errors (imagine receiving
         * ECONNREFUSED whilst talking to cn-agent). In actuality, errors end
         * up being inlined in the structure of the 'task' object.
         *
         * It would be useful to refactor CNAPI such that it enables us to
         * differentiate between unsuccessful task requests and errors
         * encountered during posting and waiting.
         */

        wait(function (err) {
            get(function () {
                req.log.debug({ task: task },
                    'handlerTaskWait: got task after wait',
                    req.params.taskid, task.status);
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
                if (err && VError.hasCauseWithName(err,
                                                   'ObjectNotFoundError'))
                {
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
            timeoutSeconds:
                req.params.timeout && parseInt(req.params.timeout, 10) || 3600
        }, function (err, _task) {
            if (err) {
                req.log.debug(
                    { err: err }, 'handlerTaskWait: waitForTask error');
                cb(err);
                return;
            }
            task = _task;
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
