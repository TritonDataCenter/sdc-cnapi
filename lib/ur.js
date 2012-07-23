/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Ur client wrapper.
 */


var util = require('util');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var common = require('./common');

function Ur(options) {
    if (typeof (options) !== 'object')
        throw new TypeError('amqp options (Object) required');

    this.queue = 'ur.cnapi';
    this.log = options.log;

    EventEmitter.call(this);
}

util.inherits(Ur, EventEmitter);

Ur.prototype.useConnection = function (connection) {
    var self = this;
    self.connection = connection;
    self.connection.on('ready', self.onConnect.bind(self));
};

Ur.prototype.onConnect = function () {
    var self = this;
    var queue = self.connection.queue(self.queue);

    self.log.info('Opening Ur AMQP queue');
    queue.on('open', function () {
        queue.bind('ur.startup.#');

        self.log.info('Listening on Ur queue');
        queue.subscribeJSON(function (message, headers, deliveryInfo) {
            self.emit('serverStartup', message, deliveryInfo.routingKey);
        });
    });
};

Ur.prototype.serverSysinfo = function (uuid, callback) {
    var self = this;
    var reqid = common.genId();
    var queue = this.connection.queue('ur.cnapi.' + reqid);
    queue.on('open', function () {
        queue.bind('ur.execute-reply.' + uuid + '.' + reqid);
        queue.subscribeJSON(function (msg, headers, deliveryInfo) {
            if (msg.exit_status !== 0) {
                return callback(
                    new Error(
                        'Error running sysinfo on remote system: '
                            + msg.stdout.toString()));

            }
            var sysinfo = JSON.parse(msg.stdout.toString());
            queue.destroy();
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

Ur.prototype.broadcastSysinfo = function (callback) {
    var self = this;
    var reqid = common.genId();
    var queue = this.connection.queue('ur.cnapi.' + reqid);
    var timeout = 10;
    var sysinfoCollection = [];

    self.log.info(
        'Requesting broadcast sysinfo from compute nodes in datacenter');
    queue.on('open', function () {
        queue.bind('ur.execute-reply.*.' + reqid);
        queue.subscribeJSON(function (msg, headers, deliveryInfo) {
            sysinfoCollection.push(msg);
        });
        var exchange = self.connection.exchange('amq.topic');
        setTimeout(function () {
            self.log.info(
                'Collected sysinfo from %d servers',
                sysinfoCollection.length);
            callback(null, sysinfoCollection);
            queue.destroy();
            return;
        }, timeout * 1000);

        exchange.publish(
            'ur.broadcast.sysinfo.' + reqid,
            {
                type: 'file',
                file: '/usr/bin/sysinfo'
            });
    });
};

Ur.prototype.execute = function (opts, callback) {
    var self = this;
    var reqid = common.genId();
    var message = opts.message;
    var timeoutSeconds = 10*60;
    var timeout;
    var uuid = opts.uuid;

    var queue = this.connection.queue('ur.cnapi.' + reqid);
    queue.on('open', function () {
        self.log.info('queue opened');
        queue.bind('ur.execute-reply.' + uuid + '.' + reqid);
        queue.subscribeJSON(function (msg, headers, deliveryInfo) {
            if (msg.exit_status !== 0) {
                return callback(
                    new Error(
                        'Error executing on remote system: '
                            + msg.stdout.toString()), msg.stdout, msg.stderr);

            }
            clearTimeout(timeout);
            queue.destroy();
            return callback(null, msg.stdout, msg.stderr);
        });

        var exchange = self.connection.exchange('amq.topic');
        timeout = setTimeout(function () {
            queue.destroy();
            callback(
                new Error(
                    'Timed out waiting for ur response after '
                    + timeoutSeconds + ' seconds'));
        }, timeoutSeconds * 1000);


        exchange.publish(
            'ur.execute.' + uuid + '.' + reqid,
            message);
    });
};

module.exports = Ur;
