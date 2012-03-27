var path = require('path');
var async = require('async');

var common = require('../lib/common');
var createUfdsModel = require('../lib/models').createUfdsModel;

var configFilename = path.join(__dirname, '..', 'config', 'config.coal.json');

module.exports = {
    "list servers": function (test) {
        var config;
        var model;

        async.waterfall([
            function (wf$callback) {
                common.loadConfig(configFilename, function (error, c) {
                    config = c;
                });
            },
            function (wf$callback) {
                console.dir(config);
                model = createUfdsModel({ ufds: config.ufds });
                model.connect(function () {
                    console.info("Connected to ufds model");
                    wf$callback();
                });
            },
            function (wf$callback) {
                model.listServers({}, function (error, servers) {
                    console.info("Listed servers");
                    console.dir(servers);
                    test.equal(servers.length, 1, "Servers were returned in query");
                    wf$callback();
                });
            }
        ],
        function (error) {
            test.done();
        });
    }
};
