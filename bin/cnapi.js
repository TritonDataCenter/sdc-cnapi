/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Main entry-point for the CNAPI.
 */

var App = require('../lib/app');
var common = require('../lib/common');
var path = require('path');

var configFilename = path.join(__dirname, '..', 'config', 'config.json');
common.loadConfig(configFilename, function (error, config) {
    var app = new App(config);
    app.start();
});
