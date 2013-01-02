var ModelServer = require('../models/server');

function Task() {}

/**
 * Returns the details of the given task.
 *
 * @name TaskGet
 * @endpoint GET /tasks/:task_id
 *
 * @example GET /tasks/a1b2c3d4
 *
 * @response 200 Object Task details
 * @response 404 None No such task found
 */

Task.get = function (req, res, next) {
    res.send(ModelServer.tasks[req.params.taskid]);
    next();
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // Get task details
    http.get(
        { path: '/tasks/:taskid', name: 'TaskGet' },
        Task.get.bind(toModel));
}

exports.attachTo = attachTo;
