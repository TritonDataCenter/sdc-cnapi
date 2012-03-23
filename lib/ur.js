/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('util');
var amqp = require('amqp');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;

function Ur(options) {
    if (typeof (options) !== 'object')
        throw new TypeError('amqp options (Object) required');
    if (typeof (options.host) !== 'string')
        throw new TypeError('amqp host (String) required');

    this.host = options.host;
    this.queue = options.queue || 'ur.cnapi';

    EventEmitter.call(this);

    var self = this;
    var connection
        = this.connection
        = amqp.createConnection({ host: this.host });

    connection.on('error', function (err) {
        self.emit('connectionError', err);
    });

    connection.on('ready', function () {
        console.log('Listening on Ur queue');
        var queue = connection.queue(self.queue);

        queue.on('open', function () {
            queue.bind('ur.startup.#');

            queue.subscribeJSON(function (message, headers, deliveryInfo) {
                self.emit('serverStartup', message, deliveryInfo.routingKey);
            });
        });
    });
}

util.inherits(Ur, EventEmitter);

Ur.prototype.reconnect = function () {
    this.connection.reconnect();
};

module.exports = Ur;
