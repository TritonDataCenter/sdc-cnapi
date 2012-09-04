var ModelServer = require('../models/server');

function Task() {}

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
        { path: '/tasks/:taskid', name: 'GetTask' },
        Task.get.bind(toModel));
}

exports.attachTo = attachTo;
