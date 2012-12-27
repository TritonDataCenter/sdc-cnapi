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

    if (req.params.platform) {
        params.boot_platform = req.params.platform;
    }
    if (req.params.kernel_args) {
        params.boot_params = req.params.kernel_args;
    }

    ModelServer.updateDefaultServer(
        params,
        function (error) {
            if (error) {
                next(
                    new restify.InternalError(error.message));
                return;
            }
            res.send(204);
            next();
            return;
        });
};

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

/**
 * Updates the boot parameters of a server.
 *
 * Completely overrides the platform and boot parameters of a server. If a
 * value is not set in the new object but is in the old one, it will be
 * effectively deleted when the new object replaces the old.
 *
 * @name BootParamsSet
 * @endpoint POST /servers/:server_uuid
 *
 * @param kernel_args Object Boot parms to update
 * @param platform String Set platform as the bootable platform
 *
 * @example POST /servers/:server_uuid -d '{ "platform": "1234Z" }'
 * @example POST /servers/:server_uuid -d '{ "kernel_args": { "foo": "bar" } }'
 *
 * @response 202 None No content
 */

BootParams.setByUuid = function (req, res, next) {
    var self = this;
    var values = {};

    if (!req.params.kernel_args) {
        req.params.kernel_args = req.params.params;
    }

    if (!req.params.kernel_args) {
        req.params.kernel_args = {};
    }

    values.boot_params = req.params.kernel_args;
    values.boot_platform = req.params.platform || 'latest';

    req.params.server.setBootParams(
        values,
        function (error, params) {
            if (error) {
                self.log.error(error);
                next(
                    new restify.InternalError(error.message));
                return;
            }
            res.send(params);
            next();
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
    http.post(
        { path: '/boot/default', name: 'BootParamsUpdateDefault' },
        BootParams.updateDefault);

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
