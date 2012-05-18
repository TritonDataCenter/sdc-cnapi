var path = require('path');
var async = require('async');
var util = require('util');

var common = require('../lib/common');
var createModel = require('../lib/models').createModel;

var configFilename = path.join(__dirname, '..', 'config', 'config.json');

/*
 * module.exports = {
 *     setUp: function (callback) {
 *         var self = this;
 *         var config;
 *
 *         async.waterfall([
 *             function (wf$callback) {
 *                 common.loadConfig(configFilename, function (error, c) {
 *                     config = c;
 *                     return wf$callback();
 *                 });
 *             },
 *             function (wf$callback) {
 *                 self.model = createUfdsModel({ ufds: config.ufds });
 *                 self.model.connect(function () {
 *                     console.info('Connected to ufds model');
 *                     return wf$callback();
 *                 });
 *             }
 *         ],
 *         function (error) {
 *             return callback(error);
 *         });
 *     },
 *     'tearDown': function (callback) {
 *         var self = this;
 *         self.model.disconnect(function () {
 *            callback();
 *         });
 *     },
 *     'list servers in all datacenters': function (test) {
 *         var self = this;
 *         self.model.listServers({}, function (error, servers) {
 *             console.info('Listed servers');
 *             console.dir(servers);
 *             test.equal(servers.length, 1, 'Should see servers returned');
 *             test.equal(error, undefined, 'Should not get any errors');
 *             test.done();
 *         });
 *     },
 *     'list servers in coal': function (test) {
 *         var self = this;
 *         self.model.listServers(
 *             { datacenter: 'coal' },
 *             function (error, servers) {
 *                 console.info('Listed servers');
 *                 console.dir(servers);
 *                 test.equal(servers.length, 1, 'Should see servers returned');
 *                 test.equal(error, undefined, 'Should not get any errors');
 *                 test.done();
 *             });
 *     }
 * };
 */

var test = require('tap').test;

function MockUfds() {
    this.history = [];
    this.callbackValues = { search: [] };
}

MockUfds.prototype.search = function (baseDn, options, callback) {
    this.history.push([baseDn, options]);
    callback(null, this.callbackValues.search.pop());
    return;
};

MockUfds.prototype.when = function (fn, arguments, results) {
    this.callbackValues[fn].push(results);
};

function newModel(callback) {
    var config;
    var model;

    var logFn = function () {};
    var log = {
        debug: logFn,
        info: logFn
    };

    var ufds = new MockUfds();

    async.waterfall([
        function (wf$callback) {
            common.loadConfig(configFilename, function (error, c) {
                config = c;
                return wf$callback();
            });
        },
        function (wf$callback) {
            model = createModel({ log: log, ufds: config.ufds });
            model.setUfds(ufds);
            wf$callback();
        }
    ],
    function (error) {
        return callback(error, model, ufds);
    });
}

test('list servers in datacenter', function (t) {
    t.plan(1);

    newModel(function (error, model, mockUfds) {
        var expSearchResults = [
            { uuid: '1234', consoletype: 'vga' },
            { uuid: '5678', consoletype: 'vga' }
        ];

        mockUfds.when('search', [], expSearchResults);

        model.listServers({}, function (list$error, servers) {
            t.same(
                [1, 2],
                mockUfds.history);
               // 'History matches'
            t.end();
        });
    });
});
