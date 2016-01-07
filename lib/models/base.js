/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var util = require('util');

function ModelBase() {
    this.log = ModelBase.getLog();
}

/**
 * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 *
 * Static Model functionality
 *
 * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
 */

ModelBase.init = function (app) {
    if (!app) {
        throw new Error('missing app');
    }

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelBase[p] = ModelBase.staticFn[p];
    });

    ModelBase.app = app;
    ModelBase.log = app.getLog();
};

ModelBase.staticFn = {
    getApp: function () {
        return this.app;
    },
    getUrClient: function (callback) {
        this.app.getUrClient(callback);
    },
    getLog: function () {
        return this.app.getLog();
    },
    getMoray: function () {
        return this.app.getMoray();
    },
    getConfig: function () {
        return this.app.getConfig();
    },
    getTaskClient: function () {
        return this.app.getTaskClient();
    },
    getWorkflow: function () {
        return this.app.getWorkflow();
    }
};

module.exports = ModelBase;
