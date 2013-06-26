var restify = require('restify');
var ModelServer = require('../models/server');

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
    var task = ModelServer.tasks[req.params.taskid];
    if (!task) {
        next(new restify.ResourceNotFoundError(
            'No such task found'));
        return;
    }
    res.send(task);
    next();
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
