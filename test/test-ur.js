var path = require('path');
var async = require('async');

var common = require('../lib/common');
var Ur = require('../lib/ur');

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
            }
        ],
        function (error) {
            self.ur = new Ur(config.amqp);
            self.ur.connect(function () {
                return callback();
            });
        });
    },
    tearDown: function (callback) {
        this.ur.connection.end();
        callback();
    },
    'ur sends sysinfo request': function (test) {
        console.log('sysinfoing');
        this.ur.serverSysinfo(
            '564dff79-e90d-6a02-ed6b-b1e158627bf8',
            function (error, sysinfo) {
                console.log(JSON.stringify(arguments, null, '  '));
                test.done();
            });
    }
};
