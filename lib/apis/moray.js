/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Moray client wrapper.
 */

var moray_client = require('moray');
var assert = require('assert-plus');
var bunyan = require('bunyan');
var async = require('async');

var BUCKETS = {
    'servers': {
        name: 'cnapi_servers',
        bucket: {
            index: {
                datacenter: { type: 'string' },
                headnode: { type: 'boolean' },
                hostname: { type: 'string' },
                overprovision_ratios: { type: 'string' },
                reserved: { type: 'boolean' },
                reservoir: { type: 'boolean' },
                setup: { type: 'boolean' },
                uuid: { type: 'string', unique: true }
            }
        }
    },
    'tasks': {
        name: 'cnapi_tasks',
        bucket: {
            index: {
                id: { type: 'string' },
                req_id: { type: 'string' },
                server_uuid: { type: 'string' },
                status: { type: 'string' },
                timestamp: { type: 'string' }
            }
        }
    },
    'waitlist_tickets': {
        name: 'cnapi_waitlist_tickets',
        bucket: {
            index: {
                created_at: { type: 'string' },
                expires_at: { type: 'string' },
                id: { type: 'string' },
                scope: { type: 'string' },
                server_uuid: { type: 'string' },
                status: { type: 'string' },
                updated_at: { type: 'string' },
                uuid: { type: 'string', unique: true },
                reqid: { type: 'string' },
                action: { type: 'string' }
            }
        }
    },
    'waitlist_queues': {
        name: 'cnapi_waitlist_queues',
        bucket: {
            index: {
                server_uuid: { type: 'string', unique: true },
                updated_at: { type: 'string' }
            //  tickets: {
            //      'id=myvmid&scope=vm': [
            //          'e3dacf2c-e6ab-11e3-bcaf-f388603f0278',
            //          'e3dad21a-e6ab-11e3-bcb0-2325e914a927'
            //      ]
            //  }
            }
        }
    },
    'status': {
        name: 'cnapi_status',
        bucket: {
            index: {
                server_uuid: { type: 'string', unique: true },
                last_heartbeat: { type: 'string' }
            }
        }
    },
    'reboot_plans': {
        name: 'cnapi_reboot_plans',
        bucket: {
            index: {
                uuid: { type: 'string', unique: true },
                concurrency: { type: 'number' },
                // Values are: "created", "stopped", "running",
                // "canceled", "complete"
                state: { type: 'string' },
                single_step: { type: 'boolean' }
            }
        }
    },
    'reboots': {
        name: 'cnapi_reboots',
        bucket: {
            index: {
                uuid: { type: 'string', unique: true },
                reboot_plan_uuid: { type: 'string' },
                job_uuid: { type: 'string' },
                server_uuid: { type: 'string' },
                boot_platform: { type: 'string' },
                current_platform: { type: 'string' },
                started_at: { type: 'string' },
                finished_at: { type: 'string' },
                operational_at: { type: 'string' },
                canceled_at: { type: 'string' }
            }
        }
    }
};


function Moray(options) {
    this.log = options.log;
    this.config = options.config;
    this.connected = false;
}

Moray.prototype.getClient = function (callback) {
    var self = this;

    if (!self._morayClient) {
        self.connect();
    }

    if (callback) {
        return callback();
    }

    return self._morayClient;
};

Moray.prototype.connect = function () {
    var self = this;
    self.log.info('Initializing moray client');
    var client = self._morayClient = moray_client.createClient({
        host: self.config.moray.host,
        port: self.config.moray.port,
        log: bunyan.createLogger({
            name: 'moray',
            serializers: bunyan.stdSerializers
        }),
        reconnect: true,
        noCache: true,
        connectTimeout: 10000,
        retry: {
            retries: Infinity,
            minTimeout: 1000,
            maxTimeout: 16000
        }
    });

    function onConnect() {
        self.log.info({moray: client.toString()}, 'moray: connected');
        self.initializeBuckets();
        self.connected = true;
    }


    client.on('connect', onConnect);
    client.on('error', function (err) {
        // not much more to do because the moray client should take
        // care of reconnecting, etc.
        self.log.error(err, 'moray client error');
    });
    return null;
};


Moray.prototype.ensureClientReady = function (callback) {
    var self = this;
    var run = true;
    var done = false;

    async.whilst(
        function () { return run; },
        function (next) {
            if (!self.connected) {
                setTimeout(next, 1000);
            }

            self.getClient().getBucket(
                BUCKETS.servers.name, function (error, bucket) {
                    if (!error) {
                        run = false;
                        next();
                        return;
                    }

                    if (error.name === 'ConnectTimeoutError') {
                        setTimeout(next, 1000);
                        return;
                    }

                    if (error.name === 'BucketNotFoundError') {
                        run = false;
                        next();
                        return;
                    }

                    if (error.name !== 'NoDatabasePeersError') {
                        self.log.info(
                            'Received %s from moray', error.message);
                        self.log.info({ error: error });
                        run = false;
                        next();
                        return;
                    }
                    setTimeout(next, 1000);
                });
        },
        function (error) {
            if (!done)  {
                done = true;
                callback(error);
            }
        });
};

Moray.prototype.initializeBuckets = function (callback) {
    var self = this;
    var moray = self.getClient();

    if (!callback) {
        callback = function () {};
    }

    self.log.info('Initializing buckets');
    async.waterfall([
        function (cb) {
            self.ensureClientReady(cb);
        },
        function (wfcb) {
            // Iterate over all the buckets descriptions, and create them.
            async.forEach(
                Object.keys(BUCKETS),
                function (key, fecb) {
                    var name = BUCKETS[key].name;
                    var bucket = BUCKETS[key].bucket;

                    moray.getBucket(name, onbucket);

                    function onbucket(error) {
                        if (error) {
                            if (error.name === 'BucketNotFoundError') {
                                self.log.info(
                                    'Moray bucket \'%s\','
                                    + ' does not yet exist, we will create it',
                                    name);
                                moray.createBucket(name, bucket, fecb);
                                return;
                            } else {
                                self.log.info(
                                    'Moray bucket error, %s, exists.',
                                    error.message);
                                fecb(error);
                                return;
                            }
                        }
                        self.log.info(
                            'Ensuring moray bucket %s up to date', name);
                        moray.updateBucket(
                            name,
                            bucket, fecb);
                    }
                },
                function (feError) {
                    if (feError) { self.log.error(feError); }
                    wfcb(feError);
                });
        },
        function (cb) {
            // Check for 'default' server object
            moray.getObject(
                BUCKETS.servers.name,
                'default',
                function (error, obj) {
                    if (error) {

                        if (error.name === 'ObjectNotFoundError') {
                            var ModelServer = require('../models/server');
                            self.log.info(
                                'Default object does not yet exist, creating'
                                + ' it now.');
                            ModelServer.setDefaultServer(cb);
                        } else {
                            self.log.warn(error);
                            cb(error);
                            return;
                        }
                    } else {
                        cb();
                    }
                });
        }
    ], callback);
};


module.exports = Moray;
module.exports.BUCKETS = BUCKETS;
