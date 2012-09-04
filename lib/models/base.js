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

ModelBase.init = function (model) {
    if (!model) {
        throw new Error('missing model');
    }

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelBase[p] = ModelBase.staticFn[p];
    });

    ModelBase.model = model;
    ModelBase.log = model.getLog();
};

ModelBase.staticFn = {
    getModel: function () {
        return this.model;
    },
    getUr: function () {
        return this.model.getUr();
    },
    getLog: function () {
        return this.model.getLog();
    },
    getUfds: function () {
        return this.model.getUfds();
    },
    getConfig: function () {
        return this.model.getConfig();
    },
    getTaskClient: function () {
        return this.model.getTaskClient();
    },
    getWorkflow: function () {
        return this.model.getWorkflow();
    },
    getWfapi: function () {
        return this.model.getWfapi();
    },
    getRedis: function () {
        return this.model.getRedis();
    }
};

module.exports = ModelBase;
