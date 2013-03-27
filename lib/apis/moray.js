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
                headnode: { type: 'boolean' },
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
            self.connected = true;

            client.on('close', function () {
                self.log.error('moray: closed');
                self.connected = false;
            });

            client.on('connect', function () {
                self.log.info('moray: reconnected');
                self.connected = true;
            });

            client.on('error', function (err) {
                self.log.warn(err, 'moray: error (reconnecting)');
                self.connected = false;
            });

            if (callback) {
                callback();
            }
        }

        function onError(err) {
            self.connected = false;
            client.removeListener('connect', onConnect);
            self.log.error(err, 'moray: connection failed');
            if (callback) {
                setTimeout(self.getClient.bind(self, callback), 1000);
            }
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
    }
    if (callback) {
        return callback();
    }

    return self._morayClient;
};


Moray.prototype.ensureClientReady = function (callback) {
    var self = this;
    var run = true;

    async.whilst(
        function () { return run; },
        function (next) {
            self.getClient().getBucket(
                BUCKETS.servers.name, function (error, bucket) {
                    self.log.info({ args: arguments });
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


module.exports = Moray;
module.exports.BUCKETS = BUCKETS;
