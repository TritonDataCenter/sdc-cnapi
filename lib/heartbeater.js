/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('util');
var amqp = require('amqp');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;

/*
 * Heartbeater constructor. options is an object with the following properties:
 *  - host: AMQP host
 *  - queue: AMQP queue. Defaults to 'heartbeat.zapi'
 *  - log: bunyan logger instance
 */
function Heartbeater(options) {
    if (typeof (options) !== 'object')
        throw new TypeError('amqp options (Object) required');
    if (typeof (options.host) !== 'string')
        throw new TypeError('amqp host (String) required');

    this.host = options.host;
    this.queue = options.queue || 'heartbeat.cnapi';

    EventEmitter.call(this);

    var self = this;
    this.log = options.log;
    var connection
        = this.connection
        = amqp.createConnection({ host: this.host });

    connection.on('error', function (error) {
        self.log.error(error, 'Heartbeater connection error');
        self.emit('connectionError', error);
    });

    connection.on('ready', function () {
        self.log.debug('Heartbeater connection ready');
        var queue = connection.queue(self.queue);

        queue.on('open', function () {
            queue.bind('heartbeat.*');

            queue.subscribeJSON(function (message, headers, deliveryInfo) {
                self.log.trace(
                    'Heartbeat received from routing key: %s',
                    deliveryInfo.routingKey);
                assert(message.zoneStatus);
                self.emit(
                    'heartbeat',
                    message.zoneStatus,
                    deliveryInfo.routingKey);
            });
        });
    });
}

util.inherits(Heartbeater, EventEmitter);

Heartbeater.prototype.reconnect = function () {
    this.connection.reconnect();
};

module.exports = Heartbeater;
