/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Redis client wrapper.
 */

var redis = require('redis');

function Redis(options) {
    this.log = options.log;
    this.config = options.config;
}

Redis.prototype.getClient = function () {
    var self = this;
    var log = self.log;

    if (!this._redisClient) {
        var client = this._redisClient = new redis.createClient(
            this.config.port || 6379,   // redis default port
            this.config.host || '127.0.0.1',
            { max_attempts: 1 });

        // Must handle 'error' event to avoid propagation to top-level where
        // node will terminate.
        client.on('error', function (err) {
            log.info(err, 'redis client error');
        });

        client.on('end', function () {
            log.info('redis client end, recycling it');
            client.end();
            self._redisClient = null;
        });

        client.select(2); // CNAPI uses DB 2 in redis.
    }
    return this._redisClient;
};

module.exports = Redis;
