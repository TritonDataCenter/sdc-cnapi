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
    getUr: function () {
        return this.app.getUr();
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
    },
    getRedis: function () {
        return this.app.getRedis();
    }
};

module.exports = ModelBase;
