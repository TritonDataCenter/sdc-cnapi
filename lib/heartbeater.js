/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var util = require('util');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;

/*
 * Heartbeater constructor. options is an object with the following properties:
 *  - host: AMQP host
 *  - queue: AMQP queue. Defaults to 'heartbeat.cnapi'
 *  - log: bunyan logger instance
 */
function Heartbeater(options) {
    if (typeof (options) !== 'object')
        throw new TypeError('amqp options (Object) required');

    EventEmitter.call(this);

    this.log = options.log;
}

util.inherits(Heartbeater, EventEmitter);

Heartbeater.prototype.useConnection = function (connection) {
    var self = this;
    self.connection = connection;
    self.connection.on('ready', self.onConnect.bind(self));
};

Heartbeater.prototype.onConnect = function () {
    var self = this;
    self.log.debug('Heartbeater connection ready');
    var queue = self.connection.queue('heartbeat.cnapi');

    queue.on('open', function () {
        queue.bind('heartbeat.*');

        queue.subscribeJSON(function (message, headers, deliveryInfo) {
            self.log.trace(
                'Heartbeat received from routing key: %s',
                deliveryInfo.routingKey);
            self.emit(
                'heartbeat',
                message,
                deliveryInfo.routingKey);
        });
    });
};

module.exports = Heartbeater;
