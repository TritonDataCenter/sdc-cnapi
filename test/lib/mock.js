var async = require('async');
var common = require('../../lib/common');
var path = require('path');
var createModel = require('../../lib/models').createModel;

var configFilename = path.join(__dirname, '..', '..', 'config', 'test.json');

function MockUfds() {
    this.history = [];
    this.callbackValues = {
    };
}

MockUfds.prototype.search = function (baseDn, options, callback) {
    this.history.push(['search', baseDn, options]);
    callback.apply(null, this.callbackValues.search.pop());
    return;
};

MockUfds.prototype.del = function (itemDn, callback) {
    this.history.push(['del', itemDn]);
    callback.apply(null, []);
    return;
};

MockUfds.prototype.add = function (baseDn, server, callback) {
    this.history.push(['add', baseDn, server]);
    callback.apply(null, []);
    return;
};

MockUfds.prototype.modify = function (baseDn, changes, callback) {
    this.history.push(['replace', baseDn, changes]);
    callback.apply(null, []);
    return;
};

MockUfds.prototype.when = function (fn, arguments, results) {
    if (!this.callbackValues[fn]) {
        this.callbackValues[fn] = [];
    }
    this.callbackValues[fn].push(results);
};

function MockRedis() {
    this.history = [];
    this.callbackValues = {
        del: [],
        hmset: [],
        hmgetall: [],
        exec: [],
        exists: []
    };
}

MockRedis.prototype.hmset = function (key, values, callback) {
    this.history.push(['hmset', key, values]);
    callback();
    return this;
};

function MockRedisWrapper() {
    this.client = new MockRedis();
}

MockRedisWrapper.prototype.getClient = function () {
    return this.client;
};

function newModel(callback) {
    var config;
    var model;

    var logFn = function () {};
    var log = {
        debug: logFn,
        trace: logFn,
        info: logFn
    };

    var ufds = new MockUfds();
    var redis = new MockRedisWrapper();

    async.waterfall([
        function (wf$callback) {
            common.loadConfig(configFilename, function (error, c) {
                config = c;
                return wf$callback();
            });
        },
        function (wf$callback) {
            model = createModel({
                log: log,
                ufds: config.ufds,
                datacenter: config.datacenter_name
            });
            model.setUfds(ufds);
            model.setRedis(redis);
            wf$callback();
        }
    ],
    function (error) {
        return callback(error, model, ufds);
    });
}

module.exports = {
    MockRedis: MockRedis,
    MockRedisWrapper: MockRedisWrapper,
    MockUfds: MockUfds,
    newModel: newModel
};
