/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the CNAPI.
 */

var CNAPI = require('../lib/cnapi');
var common = require('../lib/common');
var path = require('path');

var configFilename = path.join(__dirname, '..', 'config', 'config.json');
common.loadConfig(configFilename, function (error, config) {
    var cnapi = new CNAPI(config);
    cnapi.start();
});
