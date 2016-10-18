/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Main entry-point for the CNAPI.
 */

var path = require('path');

var bunyan = require('bunyan');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var restify = require('restify');

var App = require('../lib/app');
var bunyan = require('bunyan');
var common = require('../lib/common');

var configFilename = path.join(__dirname, '..', 'config', 'config.json');
var METRICS_SERVER_PORT = 8881;


common.loadConfig(configFilename, function (error, config) {
    var app;
    var cnapiLog;
    var metricsManager;

    cnapiLog = new bunyan({
        name: 'cnapi',
        level: config.logLevel,
        serializers: {
            err: bunyan.stdSerializers.err,
            req: bunyan.stdSerializers.req,
            res: bunyan.stdSerializers.res
        }
    });

    metricsManager = createMetricsManager({
        address: config.adminIp,
        log: cnapiLog.child({component: 'metrics'}),
        port: METRICS_SERVER_PORT,
        restify: restify,
        staticLabels: {
            datacenter: config.datacenter_name,
            instance: config.instanceUuid,
            server: config.serverUuid,
            service: config.serviceName
        }
    });

    metricsManager.createRestifyMetrics();
    metricsManager.createNodejsMetrics();
    metricsManager.listen(function metricsServerStarted() {
        app = new App(config, {
            log: cnapiLog,
            metricsManager: metricsManager
        });
        app.start();
    });
});
