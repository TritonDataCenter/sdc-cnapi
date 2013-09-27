/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Moray client wrapper.
 */

var moray_client = require('moray');
var assert = require('assert-plus');
var bunyan = require('bunyan');
var async = require('async');

var BUCKETS = {
    'servers': {
        name: 'cnapi_servers',
        bucket: {
            index: {
                uuid: { type: 'string', unique: true },
                setup: { type: 'boolean' },
                reserved: { type: 'boolean' },
                reservoir: { type: 'boolean' },
                overprovision_ratios: { type: 'string' },
                headnode: { type: 'boolean' },
                hostname: { type: 'string' },
                datacenter: { type: 'string' }
            }
        }
    }
};


function Moray(options) {
    this.log = options.log;
    this.config = options.config;
    this.connected = false;
}

Moray.prototype.getClient = function (callback) {
    var self = this;

    if (!self._morayClient) {
        self.connect();
    }

    if (callback) {
        return callback();
    }

    return self._morayClient;
};

Moray.prototype.connect = function () {
    var self = this;
    self.log.info('Initializing moray client');
    var client = self._morayClient = moray_client.createClient({
        host: self.config.moray.host,
        port: self.config.moray.port,
        log: bunyan.createLogger({
            name: 'moray',
            serializers: bunyan.stdSerializers
        }),
        noCache: true,
        connectTimeout: 10000,
        retry: {
            retries: Infinity,
            minTimeout: 1000,
            maxTimeout: 60000
        }
    });

    function onConnect() {
        client.removeListener('error', onError);
        self.log.info({moray: client.toString()}, 'moray: connected');
        self.initializeBuckets();
        self.connected = true;

        client.on('end', function () {
            self.log.error('moray: end');
            self.connected = false;
        });

        client.on('close', function () {
            self.log.error('moray: closed');
            self.connected = false;
        });

        client.on('connect', function () {
            self.log.info('moray: reconnected');
            self.connected = true;
        });

        client.on('error', function (err) {
            self.log.warn(err, 'moray: error');
        });
    }

    function onError(err) {
        self.connected = false;
        client.removeListener('connect', onConnect);
        self.log.error(err, 'moray: connection failed');
    }

    function onConnectAttempt(number, delay) {
        var level;
        if (number === 0) {
            level = 'info';
        } else if (number < 5) {
            level = 'warn';
        } else {
            level = 'error';
        }
        self.log[level]({
            attempt: number,
            delay: delay
        }, 'moray: connection attempted');
    }

    client.once('connect', onConnect);
    client.once('error', onError);
    client.on('connectAttempt', onConnectAttempt); // this we always use
    return null;
};


Moray.prototype.ensureClientReady = function (callback) {
    var self = this;
    var run = true;

    async.whilst(
        function () { return run; },
        function (next) {
            if (!self.connected) {
                setTimeout(next, 1000);
            }

            self.getClient().getBucket(
                BUCKETS.servers.name, function (error, bucket) {
                    if (!error) {
                        run = false;
                        next();
                        return;
                    }

                    if (error.name === 'ConnectTimeoutError') {
                        setTimeout(next, 1000);
                        return;
                    }

                    if (error.name === 'BucketNotFoundError') {
                        run = false;
                        next();
                        return;
                    }

                    if (error.name !== 'NoDatabasePeersError') {
                        self.log.info(
                            'Received %s from moray', error.message);
                        self.log.info({ error: error });
                        run = false;
                        next();
                        return;
                    }
                    setTimeout(next, 1000);
                });
        },
        function (error) {
            callback(error);
        });
};

Moray.prototype.initializeBuckets = function (callback) {
    var self = this;
    var moray = self.getClient();

    if (!callback) {
        callback = function () {};
    }

    self.log.info('Initializing buckets');
    async.waterfall([
        function (cb) {
            self.ensureClientReady(cb);
        },
        function (cb) {
            moray.getBucket(BUCKETS.servers.name, function (error, bucket) {
                if (error) {
                    if (error.name === 'BucketNotFoundError') {
                        self.log.info(
                            'Moray bucket \'%s\', does not yet exist. Creating'
                            + ' it.', BUCKETS.servers.name);
                        moray.createBucket(
                            BUCKETS.servers.name, BUCKETS.servers.bucket, cb);
                        return;
                    } else {
                        self.log.info(
                            'Moray bucket error, %s, exists.', error.message);
                        cb(error);
                        return;
                    }
                }
                self.log.info(
                    'Ensuring moray bucket %s up to date',
                    BUCKETS.servers.name);
                moray.updateBucket(
                    BUCKETS.servers.name, BUCKETS.servers.bucket, cb);
            });
        },
        function (cb) {
            // Check for 'default' server object
            moray.getObject(
                BUCKETS.servers.name,
                'default',
                function (error, obj) {
                    if (error) {

                        if (error.name === 'ObjectNotFoundError') {
                            var ModelServer = require('../models/server');
                            self.log.info(
                                'Default object does not yet exist, creating'
                                + ' it now.');
                            ModelServer.setDefaultServer(cb);
                        } else {
                            self.log.warn(error);
                            cb(error);
                            return;
                        }
                    } else {
                        cb();
                    }
                });
        }
    ], callback);
};


module.exports = Moray;
module.exports.BUCKETS = BUCKETS;
