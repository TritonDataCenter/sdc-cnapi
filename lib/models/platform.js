/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
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
        'LATEST=$(readlink /usbkey/os/latest)',
        'for p in `cd /usbkey/os && ls -d *`; do',
        '    if [[ $p == \'latest\' ]]; then',
        '        continue',
        '    fi',
        '    printf ${p}',
        '    if [[ $p == $LATEST ]]; then',
        '        printf  \' latest\'',
        '        echo',
        '    fi',
        '    echo',
        'done'
    ].join('\n');

    async.waterfall([
        function (cb) {
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
        function (cb) {
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
                    var platform_props = line.split(' ');
                    var platform = platformImages[platform_props[0]] = {};

                    platform_props.slice(1).forEach(function (p) {
                        platform[p] = true;
                    });
                });

                cb();
            }
        }
    ],
    function (error) {
        callback(null, platformImages);
        return;
    });
};

module.exports = ModelPlatform;
