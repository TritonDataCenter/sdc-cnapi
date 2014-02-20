/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Ur client wrapper.
 */


var util = require('util');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var common = require('./common');
var once = require('once');

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
};


Ur.prototype.bindQueues = function () {
    var self = this;

    self.log.info('Opening Ur AMQP queue');

    self.log.info('attempting to open Ur queue');
    var q = self.connection.queue(self.queue, function (queue) {
        queue.bind('ur.startup.#');
        queue.bind('ur.sysinfo.#');

        self.log.info('bound and listening on Ur queue');
        queue.subscribeJSON(function (message, headers, deliveryInfo) {
            if (deliveryInfo.routingKey.split('.')[1] === 'startup') {
                self.emit('serverStartup', message, deliveryInfo.routingKey);
            } else if (deliveryInfo.routingKey.split('.')[1] === 'sysinfo') {
                self.emit('serverSysinfo', message, deliveryInfo.routingKey);
            }
        });
    });

    q.on('error', function () {
        self.log.warn('QUEUE ERROR');
    });
};


Ur.prototype.serverSysinfo = function (uuid, callback) {
    var self = this;
    var reqid = common.genId();
    var queue = this.connection.queue('ur.cnapi.' + reqid);
    queue.on('error', function () {
        self.log.warn('QUEUE ERROR server sysinfo');
    });
    queue.on('open', function () {
        queue.bind('ur.execute-reply.' + uuid + '.' + reqid);
        queue.subscribeJSON(function (msg, headers, deliveryInfo) {
            if (msg.exit_status !== 0) {
                callback(
                    new Error(
                        'Error running sysinfo on remote system: '
                            + msg.stdout.toString()));
                return;
            }
            var sysinfo;
            try {
                sysinfo = JSON.parse(msg.stdout.toString());
            } catch (e) {
                callback(e);
                return;
            }
            queue.destroy();
            callback(null, sysinfo);
            return;
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
    var timeout = 10;
    var sysinfoCollection = [];
    self.log.info(
        'Requesting broadcast sysinfo from compute nodes in datacenter');
    var reqid = common.genId();
    var qname = 'ur.cnapi.' + reqid;
    var q = this.connection.queue(qname, function (queue) {
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
    q.on('error', function () {
        self.log.warn('error connection to ' + qname + '. reconnecting.');
        self.connection.reconnect();
    });
};


Ur.prototype.execute = function (opts, callback) {
    var self = this;
    var reqid = common.genId();
    var message = opts.message;
    var timeoutSeconds = 60*60;
    var timeout;
    var uuid = opts.uuid;

    var queue = this.connection.queue('ur.cnapi.' + reqid);
    queue.on('error', function () {
        self.log.warn('QUEUE ERROR execute');
    });
    queue.on('open', function () {
        self.log.info('queue opened');
        queue.bind('ur.execute-reply.' + uuid + '.' + reqid);
        queue.subscribeJSON(function (msg, headers, deliveryInfo) {
            self.log.info({ obj: msg }, 'The message');
            if (msg.exit_status !== 0) {
                return callback(
                    new Error('Error executing on remote system'),
                    msg.stdout,
                    msg.stderr);
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
