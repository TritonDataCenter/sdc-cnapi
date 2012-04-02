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
    this.log = options.log;

    EventEmitter.call(this);
}

util.inherits(Ur, EventEmitter);

Ur.prototype.connect = function (callback) {
    var self = this;
    var connection
        = this.connection
        = amqp.createConnection({ host: this.host });

    connection.on('error', function (err) {
        self.emit('connectionError', err);
    });

    connection.on('ready', function () {
        self.log.info('Listening on Ur queue');
        var queue = connection.queue(self.queue);

        queue.on('open', function () {
            queue.bind('ur.startup.#');

            queue.subscribeJSON(function (message, headers, deliveryInfo) {
                self.emit('serverStartup', message, deliveryInfo.routingKey);
            });

            return callback();
        });
    });
};

Ur.prototype.reconnect = function () {
    this.connection.reconnect();
};

Ur.prototype.serverSysinfo = function (uuid, callback) {
    var self = this;
    var reqid = genId();
    var queue = this.connection.queue('ur.cnapi.' + reqid);
    queue.on('open', function () {
        self.log.info('queue opened');
        queue.bind('ur.execute-reply.' + uuid + '.' + reqid);
        queue.subscribeJSON(function (msg, headers, deliveryInfo) {
            if (msg.exit_status !== 0) {
                return callback(
                    new Error(
                        'Error running sysinfo on remote system: '
                            + msg.stdout.toString()));

            }
            var sysinfo = JSON.parse(msg.stdout.toString());
            return callback(null, sysinfo);
        });
        var exchange = self.connection.exchange('amq.topic');
        exchange.publish(
            'ur.execute.' + uuid + '.' + reqid,
            {
                type: 'file',
                file: '/usr/bin/sysinfo'
            });
    });
};

function genId() {
    return Math.floor(Math.random() * 0xffffffff).toString(16);
}

module.exports = Ur;
