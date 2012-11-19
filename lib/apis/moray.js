/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Redis client wrapper.
 */

var moray_client = require('moray');
var assert = require('assert-plus');
var bunyan = require('bunyan');

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
                setTimeout(self.createClientMoray.bind(self, callback), 1000);
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

module.exports = Moray;
module.exports.BUCKETS = BUCKETS;
