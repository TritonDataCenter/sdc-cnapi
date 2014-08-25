/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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
};

Heartbeater.prototype.bindQueues = function () {
    var self = this;
    self.log.info('heartbeater connection ready');

    self.connection.queue('heartbeat.cnapi', function (queue) {
        queue.bind('heartbeat.*');

        self.log.info('subscribing to heartbeater');

        delete self.sub;
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
