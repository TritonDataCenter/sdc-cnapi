/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

const restify = require('restify');
const ModelPlatform = require('../models/platform');
const validation = require('../validation/endpoints');

function Platform() {}

Platform.init = function () {
    Platform.log = ModelPlatform.log;
};


/**
 * Returns available platform images in datacenter.
 *
 * @name PlatformList
 * @endpoint GET /platforms
 * @section Miscellaneous API
 *
 * @example GET /platforms
 *
 * @response 200 Array The returned servers
 */

Platform.list = function handlerPlatformList(req, res, next) {
    const rules = {
        'os': [
            ['optional', undefined],
            ['regex', RegExp(/^(true|false)$/i)],
            ['sanitize', 'toBoolean']
        ]
    };

    if (validation.ensureParamsValid(req, res, rules, { strict: true })) {
        next();
        return;
    }

    const params = {};
    if (req.params.hasOwnProperty('os')) {
        params.os = req.params.os;
    }

    ModelPlatform.list(params, function (error, platforms) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }
        res.send(200, platforms);
        next();
    });
};


function attachTo(http) {
    Platform.init();

    // List servers
    http.get(
        { path: '/platforms', name: 'PlatformList' },
        Platform.list);
}


exports.attachTo = attachTo;
