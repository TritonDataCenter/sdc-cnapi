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
    var timeout = null;

    if (self.connecting) {
        return;
    }

    var client = this.client = redis.createClient(
        this.config.port || 6379,
        this.config.host,
        { max_attempts: 1 });

    self.connecting = true;

    function onReady() {
        self.connected = true;
        self.connecting = false;
        clearTimeout(timeout);
        timeout = null;
        client.select(2); // CNAPI uses DB 2 in redis.

        log.debug('redis: connected');

        if (callback) {
            callback();
            return;
        }
    }

    function onError(err) {
        self.connecting = false;
        log.error(err, 'redis: client error');
        if (callback) {
            callback(err);
            return;
        }
    }
    function onEnd() {
        self.connecting = false;
        client.end();
        log.error('redis: disconnected');
        log.info('redis: reconnecting');

        // When the connection is lost we don't need to send the cb param again
        if (!timeout) {
            self.connect();
        }
    }

    function timeoutCallback() {
        self.connect();
    }

    client.once('ready', onReady);
    client.on('error', onError);
    client.once('end', onEnd);

    timeout = setTimeout(timeoutCallback, 10000);
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
