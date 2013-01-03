var ModelServer = require('../models/server');
var restify = require('restify');
var common = require('../common');

/**
 * Boot parameters are passed to compute nodes on boot. They enable one to pass
 * in information such as the platform to boot and what kernel arguments to
 * use, etc.
 */

function BootParams() {}


/*
 * Returns the default boot parameters.
 *
 * @name BootParamsGetDefault
 * @endpoint GET /boot/default
 * @section Boot Parameters
 *
 * @response 200 Object Default boot parameters and kernel_args
 * @response 404 None No such Server
 */

BootParams.getDefault = function (req, res, next) {
    ModelServer.getBootParamsDefault(
        function (error, params) {
            res.send(params);
            return next();
        });
};


/*
 * Set the default boot parameters.
 *
 * Completely override the existing boot parameter values with the given
 * payload. Any values not present in the payload will effectively be deleted.
 *
 * @name BootParamsSetDefault
 * @endpoint PUT /boot/default
 * @section Boot Parameters
 *
 * @response 204 None Boot parameters successfully set.
 * @response 404 None No such Server
 */

BootParams.setDefault = function (req, res, next) {
    var params = {
        boot_platform: req.params.platform,
        boot_params: req.params.kernel_args
    };

    ModelServer.setDefaultServer(
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


/*
 * Modify the default boot parameters.
 *
 * If a value is present in the default boot parameters, but no new value is
 * passed in, the currently effective value will remain unchanged.
 *
 * @name BootParamsUpdateDefault
 * @endpoint POST /boot/default
 * @section Boot Parameters
 *
 * @param {Object} kernel_args Boot parms to update
 * @param {String} platform Set platform as the bootable platform
 *
 * @response 204 None Boot parameters successfully set
 * @response 404 None No such Server
 */

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


/**
 * Returns the boot parameters for a particular server.
 *
 * Returns the platform to be booted on the next reboot in addition to what
 * kernel parameters will be used to boot the server.
 *
 * @name BootParamsGet
 * @endpoint GET /boot/:server_uuid
 * @section Boot Parameters
 *
 * @example GET /boot/:server_uuid
 *
 * @response 200 Object Default boot parameters and kernel_args
 * @response 404 None No such Server
 */

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
 * Set the boot parameters of a server.
 *
 * Completely overrides the platform and boot parameters of a server. If a
 * value is not set in the new object but is in the old one, it will be
 * effectively deleted when the new object replaces the old.
 *
 * @name BootParamsSet
 * @endpoint POST /boot/:server_uuid
 * @section Boot Parameters
 *
 * @param {Object} kernel_args Boot parms to update
 * @param {String} platform Set platform as the bootable platform
 *
 * @example POST /boot/:server_uuid
 *          -d '{ "platform": "1234Z",
 *                "kernel_args": { "foo": "bar" } }'
 *
 * @response 202 None No content
 * @response 404 None No such Server
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


/**
 * Update only the given boot configuration values.
 *
 * Does not overwrite any values which are not given.
 *
 * @name BootParamsUpdate
 * @endpoint POST /boot/:server_uuid
 * @section Boot Parameters
 *
 * @param {Object} kernel_args Boot parms to update
 * @param {String} platform Set platform as the bootable platform
 *
 * @example POST /boot/:server_uuid -d '{ "platform": "1234Z" }'
 * @example POST /boot/:server_uuid -d '{ "kernel_args": { "foo": "bar" } }'
 *
 * @response 202 None No content
 */

BootParams.updateByUuid = function (req, res, next) {
    if (!req.params.kernel_args) {
        req.params.kernel_args = req.params.params;
    }

    if (!req.params.kernel_args && !req.params.platform) {
        res.send(204);
        next();
        return;
    }

    var params = {};

    if (req.params.kernel_args) {
        params.boot_params = req.params.kernel_args;
    }

    if (req.params.platform) {
        params.boot_platform = req.params.platform;
    }

    req.params.server.updateBootParams(params, function (error) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }
        res.send(204);
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

    // Set the boot parameters
    http.post(
        { path: '/boot/:server_uuid', name: 'BootParamsUpdate' },
        before, BootParams.updateByUuid);
}

exports.attachTo = attachTo;
