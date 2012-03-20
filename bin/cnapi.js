/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the CNAPI.
 */

var createUfdsModel = require('../lib/models.js').createUfdsModel;
var createServer = require('../lib/server.js').createServer;
var createUfdsClient = require('../lib/ufds.js').createUfdsClient;

function main() {
    var ufdsSettings = {
        host: 'ufds_host',
        port: 12345,
        user: 'ufds_user',
        user: 'ufds_pass'
    };
    var ufdsClient = createUfdsClient(ufdsSettings);

    var modelOptions = {
        ufds: ufdsClient
    };

    var model = createUfdsModel(modelOptions);
    var server = createServer(model);

    server.listen(8080, function () {
      console.log('%s listening at %s', server.name, server.url);
    });
}

main();
