/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */
var util = require('util');

var restify = require('restify');

var ModelServer = require('../models/server');
var common = require('../common');
var validation = require('../validation/endpoints');
var ModelPlatform = require('../models/platform');

/*
 * Expected boot modules format is as follows:
 *
 * {
 *      "path": "boot module path to be used by booter",
 *      "type": "Content type. Right now only base64 is supported",
 *      "content": "File contents, if necessary encoded as specified by type"
 * }
 *
 * In the future, support for new content types or additionaly members for
 * the boot_module objects could be provided, being the defaults the originally
 * supported values.
 */
function validateBootModules(boot_modules) {
    var errs = [];
    var i;
    for (i = 0; i < boot_modules.length; i += 1) {
        var bm = boot_modules[i];
        if (!bm.path || !bm.content) {
            errs.push(util.format(
                'Unexpected format for boot_module: %j', bm));
            continue;
        }

        bm.type = bm.type || 'base64';

        if (bm.type !== 'base64') {
            errs.push(util.format(
                'Unsupported type %s for module %s', bm.type, bm.path));
            continue;
        }
        if (Buffer.from(bm.content, 'base64').toString('base64') !==
            bm.content) {
            errs.push(util.format(
                'Contents for module %s must be base64 encoded', bm.path));
            continue;
        }
        if (Buffer.byteLength(bm.content, 'base64') > 4 * 1024) {
            errs.push(util.format(
                'Module %s exceeds the maximum allowed size of 4KBs',
                bm.path));
            continue;
        }
    }

    if (errs.length) {
        var err = new restify.InvalidArgumentError(
            'Values provided for boot_modules contain errors: '
            + errs.join(',\n'));
        return err;
    }
    return null;
}

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
 * @section Boot Parameters API
 *
 * @response 200 Object Default boot parameters and kernel_args
 * @response 404 None No such Server
 */

BootParams.getDefault = function handlerBootParamsGetDefault(req, res, next) {
    ModelServer.getBootParamsDefault(
        function (error, params) {
            if (error) {
                next(
                    new restify.InternalError(error.message));
                return;
            }
            res.send(params);
            next();
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
 * @section Boot Parameters API
 *
 * @param {String} platform The platform image to use on next boot
 * @param {Object} kernel_args Key value pairs to be sent to server on boot
 * @param {Array} boot_modules List of boot module objects
 * @param {Object} kernel_flags Kernel flags to be sent to server on boot
 * @param {Object} serial Serial device to use (i.e. "ttyb")
 * @param {Object} default_console Default console type (i.e. "serial")
 *
 * @response 204 None Boot parameters successfully set.
 * @response 404 None No such Server
 */

BootParams.setDefault = function handlerBootParamsSetDefault(req, res, next) {
    var rules = {
        'platform': ['optional', 'isStringType', 'isTrim'],
        'kernel_args': ['optional', 'isObjectType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var params = {
        boot_platform: req.params.platform,
        boot_params: req.params.kernel_args,
        boot_modules: req.params.boot_modules,

        default_console: req.params.default_console,
        serial: req.params.serial
    };

    if (req.params['platform']) {
        ModelPlatform.list({}, function (error, platforms) {
            if (error) {
                next(
                    new restify.InternalError(error.message));
                return;
            }

            if (!platforms.hasOwnProperty(req.params.platform)) {
                next(new restify.InternalError(
                    'Platform \'%s\' does not exist', req.params.platform));
                return;
            } else {
                set();
            }
        });
    } else {
        set();
    }

    function set() {
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
    }
};


/*
 * Modify the default boot parameters.
 *
 * If a value is present in the default boot parameters, but no new value is
 * passed in, the currently effective value will remain unchanged.
 *
 * @name BootParamsUpdateDefault
 * @endpoint POST /boot/default
 * @section Boot Parameters API
 *
 * @param {Object} kernel_args Boot parms to update
 * @param {Array} boot_modules List of boot module objects
 * @param {Object} kernel_flags Kernel flags to update
 * @param {String} platform Set platform as the bootable platform
 *
 * @response 204 None Boot parameters successfully set
 * @response 404 None No such Server
 */

BootParams.updateDefault =
function handlerBootParamsUpdateDefault(req, res, next) {
    var rules = {
        'platform': ['optional', 'isStringType', 'isTrim'],
        'kernel_args': ['optional', 'isObjectType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var params = {};

    if (req.params.platform) {
        params.boot_platform = req.params.platform;
    }
    if (req.params.kernel_args) {
        params.boot_params = req.params.kernel_args;
    }
    if (req.params.kernel_flags) {
        params.kernel_flags = req.params.kernel_flags;
    }

    params.default_console = req.params.default_console;
    params.serial = req.params.serial;
    params.boot_modules = req.params.boot_modules;

    if (req.params['platform']) {
        ModelPlatform.list({}, function (error, platforms) {
            if (error) {
                next(
                    new restify.InternalError(error,
                        'could not list platform'));
                return;
            }

            if (!platforms.hasOwnProperty(req.params.platform)) {
                next(new restify.InternalError(
                    'Platform \'%s\' does not exist', req.params.platform));
                return;
            } else {
                update();
            }
        });
    } else {
        update();
    }

    function update() {
        ModelServer.updateDefaultServer(
            params,
            function (error) {
                if (error) {
                    next(
                        new restify.InternalError(error,
                            'could not update default server'));
                    return;
                }
                res.send(204);
                next();
                return;
            });
    }
};


/**
 * Returns the boot parameters for a particular server.
 *
 * Returns the platform to be booted on the next reboot in addition to what
 * kernel parameters will be used to boot the server.
 *
 * @name BootParamsGet
 * @endpoint GET /boot/:server_uuid
 * @section Boot Parameters API
 *
 * @example GET /boot/:server_uuid
 *
 * @response 200 Object Default boot parameters and kernel_args
 * @response 404 None No such Server
 */

BootParams.getByUuid = function handlerBootParamsGetByUuid(req, res, next) {
    req.stash.server.getBootParams(
        function (error, params) {
            if (error) {
                next(
                    new restify.InternalError(error.message));
                return;
            }
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
            next();
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
 * @endpoint PUT /boot/:server_uuid
 * @section Boot Parameters API
 *
 * @param {Object} kernel_args Boot parms to update
 * @param {Array} boot_modules List of boot module objects.
 *      Each member of this collection will be an object with the
 *      following structure:
 *      {
 *          "path": "boot module path to be used by booter",
 *          "type": "Content type. Right now only base64 is supported",
 *          "content": "File contents, if necessary encoded as specified"
 *      }
 *      File contents are expected to be base64 encoded and max content
 *      length is of 4kbs.
 *      [{
 *          "path": ...,
 *          "content": ...,
 *          "type": "base64 (default)"
 *       }, {
 *          "path": "...",
 *          "content": "..."
 *       }, ...]
 * @param {Object} kernel_values Kernel flags to update
 * @param {String} platform Set platform as the bootable platform
 * @param {Object} serial Serial device to use (i.e. "ttyb")
 * @param {Object} default_console Default console type (i.e. "serial")
 *
 * @example PUT /boot/:server_uuid
 *          -d '{ "platform": "1234Z",
 *                "kernel_args": { "foo": "bar" } }'
 *
 * @response 202 None No content
 * @response 404 None No such Server
 */

BootParams.setByUuid = function handlerBootParamsSetByUuid(req, res, next) {
    var rules = {
        'platform': ['optional', 'isStringType', 'isTrim'],
        'default_console': ['optional', 'isStringType', 'isTrim'],
        'serial': ['optional', 'isStringType', 'isTrim'],
        'kernel_args': ['optional', 'isObjectType'],
        'kernel_flags': ['optional', 'isObjectType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    var values = {};

    if (!req.params.kernel_args) {
        req.params.kernel_args = req.params.boot_params;
    }

    if (!req.params.kernel_args) {
        req.params.kernel_args = {};
    }

    values.boot_params = req.params.kernel_args;

    values.default_console = req.params.default_console;
    values.kernel_flags = req.params.kernel_flags;
    values.serial = req.params.serial;

    if (req.params.boot_modules) {
        var bootmErr = validateBootModules(req.params.boot_modules);
        if (bootmErr) {
            res.send(bootmErr);
            next();
            return;
        }
    }

    values.boot_modules = req.params.boot_modules || [];

    ModelPlatform.list({}, function (error, platforms) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        if (req.params.platform &&
                !platforms.hasOwnProperty(req.params.platform)) {
            next(new restify.InternalError(
                'Platform \'%s\' does not exist', req.params.platform));
            return;
        } else {
            values.boot_platform = req.params.platform ||
                Object.keys(platforms).filter(function (p) {
                    return (platforms[p].latest);
                }).pop();
            set();
        }
    });

    function set() {
        req.stash.server.setBootParams(
            values,
            function (error, params) {
                if (error) {
                    req.log.error(error);
                    next(
                        new restify.InternalError(error.message));
                    return;
                }
                res.send(params);
                next();
            });
    }
};


/**
 * Update only the given boot configuration values.
 *
 * Does not overwrite any values which are not given.
 *
 * @name BootParamsUpdate
 * @endpoint POST /boot/:server_uuid
 * @section Boot Parameters API
 *
 * @param {Object} kernel_args Boot parms to update
 * @param {Object} kernel_flags Hash containing flag key/value pairs
 * @param {Array} boot_modules List of boot module objects.
 *      Each member of this collection will be an object with the
 *      following structure:
 *      {
 *          "path": "boot module path to be used by booter",
 *          "type": "Content type. Right now only base64 is supported",
 *          "content": "File contents, if necessary encoded as specified"
 *      }
 *      File contents are expected to be base64 encoded and max content
 *      length is of 4kbs.
 *      [{
 *          "path": ...,
 *          "content": ...,
 *          "type": "base64 (default)"
 *       }, {
 *          "path": "...",
 *          "content": "..."
 *       }, ...]
 * @param {String} platform Set platform as the bootable platform
 *
 * @example POST /boot/:server_uuid -d '{ "platform": "1234Z" }'
 * @example POST /boot/:server_uuid -d '{ "kernel_args": { "foo": "bar" } }'
 *
 * @response 202 None No content
 */

BootParams.updateByUuid =
function handlerBootParamsUpdateByUuid(req, res, next) {
    var rules = {
        'platform': ['optional', 'isTrim', 'isStringType'],
        'kernel_args': ['optional', 'isObjectType']
    };

    if (validation.ensureParamsValid(req, res, rules)) {
        next();
        return;
    }

    if (!req.params.kernel_args) {
        req.params.kernel_args = req.params.params;
    }

    var params = {};

    if (req.params.kernel_args) {
        params.boot_params = req.params.kernel_args;
    }

    if (req.params.platform) {
        params.boot_platform = req.params.platform;
    }

    if (req.params.kernel_flags) {
        params.kernel_flags = req.params.kernel_flags;
    }

    params.default_console = req.params.default_console;
    params.serial = req.params.serial;

    if (req.params.boot_modules) {
        var bootmErr = validateBootModules(req.params.boot_modules);
        if (bootmErr) {
            res.send(bootmErr);
            next();
            return;
        }
    }

    params.boot_modules = req.params.boot_modules;

    if (req.params['platform']) {
        ModelPlatform.list({}, function (error, platforms) {
            if (error) {
                next(
                    new restify.InternalError(error.message));
                return;
            }



            if (!platforms.hasOwnProperty(req.params.platform)) {
                next(new restify.InternalError(
                    'Platform \'%s\' does not exist', req.params.platform));
                return;
            } else {
                update();
            }
        });
    } else {
        update();
    }

    function update() {
        req.stash.server.updateBootParams(params, function (error) {
            if (error) {
                next(
                    new restify.InternalError(error.message));
                return;
            }
            res.send(204);
            next();
        });
    }
};

function attachTo(http, app) {
    var ensure = require('../endpoints').ensure;

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
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        BootParams.getByUuid);

    // Set the boot parameters
    http.put(
        { path: '/boot/:server_uuid', name: 'BootParamsSet' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        BootParams.setByUuid);

    // Set the boot parameters
    http.post(
        { path: '/boot/:server_uuid', name: 'BootParamsUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        BootParams.updateByUuid);
}

exports.attachTo = attachTo;
