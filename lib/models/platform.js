/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This file contains all the necessary logic manipulate the platform images
 * on the head-node.
 */

var async = require('async');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var ModelBase = require('./base');
var ModelServer = require('./server');

function ModelPlatform(id) {
    if (!id) {
        throw new Error('ModelPlatform missing uuid parameter');
    }

    this.log = ModelPlatform.getLog();
}

ModelPlatform.init = function (app) {
    this.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelPlatform[p] = ModelBase.staticFn[p];
    });

    ModelPlatform.log = app.getLog();
};

/**
 * Return an array of platform image names, indicating which is the latest.
 */

ModelPlatform.list = function (params, callback) {
    var self = this;
    this.log.debug({ params: params }, 'Listing platforms');
    var server;
    var platformImages = {};
    var script = [
        'for p in `cd /usbkey/os && ls -d *`; do',
        '    if [[ $p == \'latest\' ]]; then',
        '        continue',
        '    fi',
        '    printf ${p}',
        '    echo',
        'done'
    ].join('\n');

    async.waterfall([
        function getHN(cb) {
            ModelServer.list({ headnode: true }, function (error, servers) {
                if (error) {
                    cb(new Error('Error finding headnode: ' + error.message));
                    return;
                }

                if (!servers.length) {
                    cb(new Error('Could not find headnode'));
                    return;
                }
                self.log.info({ server: servers }, 'platform servers');

                ModelServer.get(servers[0].uuid, function (err, servermodel) {
                    if (err) {
                        cb(err);
                        return;
                    }
                    server = servermodel;
                    cb();
                });
            });
        },
        function runUrScript(cb) {
            server.invokeUrScript(script, {}, onUrResponse);

            function onUrResponse(error, stdout, stderr) {
                if (error) {
                    cb(new Error(
                        'Error executing platform list script: '
                        + error.message));
                    return;
                }

                stdout.toString().split('\n').forEach(function (line) {
                    if (!line) {
                        return;
                    }

                    platformImages[line] = {};
                });
                cb();
            }
        },
        function findLatestPlatform(cb) {
            // We'll figure out which platform is latest using just platform
            // name sorting, since default platform names follow the pattern
            // YYYYMMDDTHHMMSSZ:
            var RE = /\d{8}T\d{6}Z/;
            var imgs = Object.keys(platformImages).filter(function (img) {
                return RE.test(img);
            }).sort();
            var latest = imgs.pop();
            platformImages[latest].latest = true;
            cb();
        }
    ],
    function (error) {
        callback(null, platformImages);
        return;
    });
};

module.exports = ModelPlatform;
