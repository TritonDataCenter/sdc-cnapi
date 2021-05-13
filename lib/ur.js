/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Ur client wrapper.
 */


var util = require('util');
var verror = require('verror');
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
        queue.bind('ur.sysinfo.#');

        self.log.info('bound and listening on Ur queue');
        queue.subscribeJSON(function (message, headers, deliveryInfo) {
            if (deliveryInfo.routingKey.split('.')[1] === 'sysinfo') {
                self.emit('serverSysinfo', message, deliveryInfo.routingKey);
            }
        });

        self.exchange = self.connection.exchange('amq.topic');
        self.log.info('created topic exchange');
    });

    q.on('error', function () {
        self.log.warn('QUEUE ERROR');
    });
};


/* BEGIN JSSTYLED */
/**
 * Sends an Ur execute payload to a given server's Ur agent and then returns
 * the captured stdout and stderr streams.
 *
 * @name UrServerExecute
 * @section CnapiUr
 *
 * @param {Number} opts.uuid UUID of server on which to execute payload
 * @param {Number} opts.timeoutSeconds Number of seconds to wait for a result before returning an error
 * @param {Function} callback Function to call with stdout and stderr strings, and exit status
 */
/* END JSSTYLED */

Ur.prototype.execute = function (opts, callback) {
    var self = this;
    var reqid = common.genId();
    var message = opts.message;
    var timeoutSeconds = opts.timeoutSeconds || 60*60;
    var timeout;
    var uuid = opts.uuid;

    callback = once(callback);

    var ctag;
    self.connection.queue(
        'ur.cnapi.' + reqid,
        { autoDelete: true, closeChannelOnUnsubscribe: true },
        onopen);

    function onopen(queue) {
        queue.on('error', function (e) {
            self.log.error(e, 'QUEUE ERROR execute');
        });

        queue.subscribe(function (msg, headers, deliveryInfo, messageObject) {
            self.log.trace({ obj: msg }, 'Ur reply');
            clearTimeout(timeout);
            queue.unsubscribe(ctag);
            setTimeout(function () {
                queue.destroy();
            }, 1000);
            return callback(null, msg.stdout, msg.stderr, msg.exit_status);
        })
        .addCallback(function (ok) {
            ctag = ok.consumerTag;
            queue.bind('ur.execute-reply.' + uuid + '.' + reqid,
                function () {
                    self.exchange.publish(
                        'ur.execute.' + uuid + '.' + reqid,
                        message);
                });
        });

        timeout = setTimeout(function () {
            queue.unsubscribe(ctag);
            setTimeout(function () {
                queue.destroy();
            }, 1000);
            callback(
                new Error(
                    'Timed out waiting for ur response after '
                    + timeoutSeconds + ' seconds'));
        }, timeoutSeconds * 1000);
    }
};

module.exports = Ur;
