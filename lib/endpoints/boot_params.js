var ModelServer = require('../models/server');
var restify = require('restify');
var common = require('../common');

function BootParams() {}

BootParams.getDefault = function (req, res, next) {
    ModelServer.getBootParamsDefault(
        function (error, params) {
            res.send(params);
            return next();
        });
};

BootParams.setDefault = function (req, res, next) {
    var params = {};

    params.boot_platform = req.params.platform;
    params.boot_params = req.params.kernel_args;

    ModelServer.setDefaultServer(
        params,
        function (error) {
            if (error) {
                next(
                    new restify.InternalError(error.message));
                return;
            }
            res.send(200);
            next();
            return;
        });
};

BootParams.updateDefault = function (req, res, next) {
    var params = {};
    
    params.boot_platform = req.params.platform;
    params.boot_params = req.params.kernel_args;

    ModelServer.updateDefaultServer(
        params,
        function (error) {
            if (error) {
                next(
                    new restify.InternalError(error.message));
                return;
            }
        });
}

BootParams.getByUuid = function (req, res, next) {
    req.params.server.getBootParams(
        function (error, params) {
            var kernel_args = params.kernel_args;
            for (var i in kernel_args) {
                if (!kernel_args.hasOwnProperty(i)) {
                    continue;
                }

                if (common.isString(kernel_args[i])) {
                    kernel_args[i] = kernel_args[i];
                }
            }
            res.send(params);
            return next();
        });
};

BootParams.setByUuid = function (req, res, next) {
    var bootParams;

    if (!req.params.params) {
        req.params.params = '{}';
    }

    try {
        bootParams = req.params.params;
    }
    catch (e) {
        next(
            new restify.InvalidContentError(
                '"params" parameter was not valid JSON'));
        return;
    }

    req.params.server.setBootParams(
        bootParams,
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
    // Return the default boot parameters (for any server)
    http.get(
        { path: '/boot/default', name: 'BootParamsGetDefault' },
        BootParams.getDefault);

    // Override the default boot parameters.
    http.put(
        { path: '/boot/default', name: 'BootParamsSetDefault' },
        BootParams.setDefault);

    // Modify the default boot parameters.
    http.update(
        { path: '/boot/default', name: 'BootParamsUpdateDefault' },
        BootParams.setDefault);

    // Return the boot parameters for a particular server
    http.get(
        { path: '/boot/:server_uuid', name: 'BootParamsGet' },
        before, BootParams.getByUuid);

    // Set the boot parameters
    http.put(
        { path: '/boot/:server_uuid', name: 'BootParamsSet' },
        before, BootParams.setByUuid);
}

exports.attachTo = attachTo;
