var ModelServer = require('../models/server');
var restify = require('restify');

function BootParams() {}

BootParams.getDefault = function (req, res, next) {
    ModelServer.getBootParamsDefault(
        function (error, params) {
            res.send(params);
            return next();
        });
};

BootParams.getByUuid = function (req, res, next) {
    req.params.server.getBootParams(
        function (error, params) {
            res.send(params);
            return next();
        });
};

function attachTo(http, model) {
    var before = [
        function (req, res, next) {
            if (!req.params.server_uuid) {
                next();
                return;
            }

            req.params.server = new ModelServer(req.params.server_uuid);
            req.params.server.get(function (error, server) {
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
    // Return the default boot parameters (for any server)
    http.get(
        { path: '/boot/default', name: 'GetDefaultBootParams' },
        BootParams.getDefault);

    // Return the boot parameters for a particular server
    http.get(
        { path: '/boot/:server_uuid', name: 'GetBootParams' },
        before, BootParams.getByUuid);
}

exports.attachTo = attachTo;
