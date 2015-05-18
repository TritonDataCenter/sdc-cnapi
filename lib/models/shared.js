/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/**
 * This module is used to avoid circular reference issues when using require
 * between ModelPlatform and ModelServer
 */

var util = require('util');

function GetHN(log, cb) {
    var ModelServer = require('./server');
    ModelServer.list({ headnode: true }, function (error, servers) {
        if (error) {
            cb(new Error('Error finding headnode: ' + error.message));
            return;
        }

        if (!servers.length) {
            cb(new Error('Could not find headnode'));
            return;
        }

        ModelServer.get(servers[0].uuid, function (err, servermodel) {
            if (err) {
                cb(err);
                return;
            }
            cb(null, servermodel);
        });
    });

}
module.exports = GetHN;
