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
var restify = require('restify');
var tritonMetrics = require('triton-metrics');

var App = require('../lib/app');
var common = require('../lib/common');

var configFilename = path.join(__dirname, '..', 'config', 'config.json');
var createMetricsManager = tritonMetrics.createMetricsManager;
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
        metricOpts: {
            http_request_duration_seconds: {
                // The buckets here match the defaults in node-triton-metrics,
                // but we set them anyway and set a buckets_version so that we
                // can change them independently if we want to.
                buckets: tritonMetrics.logLinearBuckets(10, -5, 3, 5)
                    .filter(function _trimBuckets(v) {
                        // Limit to >= 0.001 and <= 10000 as this is the range of
                        // observed values for all Triton APIs we surveyed
                        // across a month of production data.
                        if (v > 10000 || v < 0.001) {
                            return false;
                        }
                        return true;
                    }),
                labels: {
                    buckets_version: 'cnapi.2'
                }
            }
        },
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
