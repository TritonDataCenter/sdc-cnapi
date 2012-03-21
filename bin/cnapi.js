/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the CNAPI.
 */

var createUfdsModel = require('../lib/models').createUfdsModel;
var createServer = require('../lib/server').createServer;
var async = require('async');

function main() {
    var server;
    var model;

    var modelOptions = {
        ufdsSettings: {
            host: 'ufds_host',
            port: 12345,
            user: 'ufds_user',
            user: 'ufds_pass'
        }
    };

    async.waterfall([
        function (wf$callback) {
            model = createUfdsModel(modelOptions);
            // model.onError(...);
            model.connect(function () {
                return wf$callback();
            });
        },
        function (wf$callback) {
            var serverOptions = {
                model: model
            };
            server = createServer(serverOptions);
            return wf$callback();
        }
    ],
    function (error) {
        server.listen(8080, function () {
          console.log('%s listening at %s', server.name, server.url);
        });
    });
}

main();
