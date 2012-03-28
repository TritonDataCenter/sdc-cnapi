var path = require('path');
var async = require('async');

var common = require('../lib/common');
var createUfdsModel = require('../lib/models').createUfdsModel;

var configFilename = path.join(__dirname, '..', 'config', 'config.coal.json');

module.exports = {
    setUp: function (callback) {
        var self = this;
        var config;
        
        async.waterfall([
            function (wf$callback) {
                common.loadConfig(configFilename, function (error, c) {
                    config = c;
                    return wf$callback();
                });
            },
            function (wf$callback) {
                console.dir(config);
                self.model = createUfdsModel({ ufds: config.ufds });
                self.model.connect(function () {
                    console.info("Connected to ufds model");
                    return wf$callback();
                });
            },
        ],
        function (error) {
            return callback(error);
        });
    },
    "tearDown": function (callback) {
        var self = this;
        self.model.disconnect(function () {
           callback();
        });
    },
    "list servers in all datacenters": function (test) {
        var self = this;
        self.model.listServers({}, function (error, servers) {
            console.info("Listed servers");
            console.dir(servers);
            test.equal(servers.length, 1, "Should see servers returned");
            test.equal(error, undefined, "Should not get any errors");
            test.done();
        });
    },
    "list servers in coal": function (test) {
        var self = this;
        self.model.listServers({ datacenter: "coal" }, function (error, servers) {
            console.info("Listed servers");
            console.dir(servers);
            test.equal(servers.length, 1, "Should see servers returned");
            test.equal(error, undefined, "Should not get any errors");
            test.done();
        });
    },
    "list servers in non-existent datacenter": function (test) {
        var self = this;
        self.model.listServers({ datacenter: "idontexist" }, function (error, servers) {
            console.info("Listed servers");
            console.dir(servers);
            test.equal(servers.length, 0, "Should see no servers returned");
            test.equal(error, undefined, "Should not get any errors");
            test.done();
        });
    }
};
