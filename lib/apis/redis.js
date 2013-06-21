/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Redis client wrapper.
 */

var redis = require('redis');

function Redis(options) {
    this.log = options.log;
    this.config = options.config;
    this.connected = false;
    this.connecting = false;
}

Redis.prototype.connect = function (callback) {
    var self = this;
    var log = this.log;

    if (self.connecting) {
        return;
    }

    var client;

    try {
        client = this.client = redis.createClient(
            this.config.port || 6379,
            this.config.host,
            {
                max_attempts: null,
                retry_max_delay: 5000
            });
    } catch (e) {
        setTimeout(function () {
            self.log.error(e, 'Exception on trying to connect to redis');
            self.connect();
        }, 5000);
    }

    self.connecting = true;

    client.once('ready', onReady);
    client.on('error', onError);
    client.once('end', onEnd);

    function onReady() {
        self.connected = true;
        self.connecting = false;
    }

    function onError(err) {
        self.connecting = false;
        log.error(err, 'redis: client error');
    }
    function onEnd() {
        self.connected = false;
        self.connecting = false;
        log.error('redis: disconnected');
        log.info('redis: reconnecting');

    }
};

Redis.prototype.getClient = function (callback) {
    var self = this;

    if (!self.client) {
        self.log.info('Initializing redis client');

        self.connect(callback);
        return null;
    }

    return self.client;
};

Redis.prototype.isConnected = function () {
    return (this.client && this.connected);
};

module.exports = Redis;
