/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * This is where the core of CNAPI abstractions and logic is defined.
 */

var assert = require('assert-plus');
var async = require('async');
var crypto = require('crypto');
var execFile = require('child_process').execFile;
var http = require('http');
var https = require('https');
var VError = require('verror');
var sprintf = require('sprintf').sprintf;
var tritonTracer = require('triton-tracer');
var util = require('util');
var once = require('once');
var os = require('os');

var amqp = require('amqp');
var buckets = require('./apis/moray').BUCKETS;
var common = require('./common');
var createServer = require('./server').createServer;
var Designation = require('./designation');
var HeartbeatReconciler = require('./heartbeat_reconciler');
var ModelBase = require('./models/base');
var ModelImage = require('./models/image');
var ModelPlatform = require('./models/platform');
var ModelWaitlist = require('./models/waitlist');
var ModelServer = require('./models/server');
var ModelVM = require('./models/vm');
var Moray = require('./apis/moray');
var Ur = require('./ur');
var Workflow = require('./apis/workflow');



var TASK_CLEANUP_MAX_AGE = 30 * 24 * 60 * 60;
var TASK_CLEANUP_PERIOD = 60 * 60;
var UNSETUP_UR_SYSINFO_TIMEOUT_SECONDS = 90;



function App(config, opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.metricsManager, 'opts.metricsManager');

    self.config = config;
    self.log = opts.log;

    tritonTracer.init({
        log: self.log,
        sampling: {
            route: {
                ping: 0.01,
                servereventheartbeat: 0.01,
                servereventvmsupdate: 0.01
            }
        }
    });

    self.cnapi_instance = os.hostname();

    self.serversNeedSysinfo = {};

    self.log.info({ config: config }, 'cnapi config');
    self.config.log = self.log;
    self.metricsManager = opts.metricsManager;
    self.taskCallbacks = {};

    // Will store current heartbeat status for all servers we've seen recently.
    self.observedHeartbeats = {};
    self.heartbeatingServersGauge = self.metricsManager.collector.gauge({
        name: 'heartbeating_servers_count',
        help: 'Number of servers from which this CNAPI has recent heartbeats'
    });
    self.metricsManager.addPreCollectFunc(function _hbServersGaugeSet(cb) {
        var heartbeatingServers = Object.keys(self.observedHeartbeats).length;

        self.heartbeatingServersGauge.set(heartbeatingServers);
        cb();
    });

    // Will store info about unsetup servers so we know when they are running.
    self.unsetupServers = {};

    ModelBase.init(self);
    ModelImage.init(self);
    ModelPlatform.init(self);
    ModelServer.init(self);
    ModelWaitlist.init(self);
    ModelVM.init(self);

    Designation.init(self);

    self.statusTimeouts = {};
}



/**
 *
 * CNAPI Start-up sequence:
 *
 * # Initiate HTTP Interface
 *
 * This will allow CNAPI to begin responding to requests immediately, even if
 * they are 500's.
 *
 * # Setup metrics
 *
 * This will setup a node-triton-metrics instance and connect it to the restify
 * server.
 *
 * # Make connections
 *
 * Connection phase: open connection to all upstream services we depend on.
 * - connect to Workflow API
 * - connect to Moray
 * - connect to AMQP
 *
 * # Setup resources
 *
 * Setup phase: Set up resources needed for normal operation
 * - create queues
 * - setup workflows
 * - broadcast request for information from all servers
 *
 * Once connected to all of the above we begin listening for heartbeats.
 */

App.prototype.start = function () {
    var self = this;

    self.start_timestamp = (new Date()).toISOString();

    async.waterfall([
        function (wfcb) {
            execFile('/usr/bin/zonename', [],
                function (error, stdout, stderr) {
                    if (error) {
                        wfcb(error);
                        return;
                    }
                    self.uuid = stdout.toString();
                    wfcb();
                });
        },
        function (wfcb) {
            execFile('/opt/local/bin/uname', ['-v'],
                function (error, stdout, stderr) {
                    if (error) {
                        wfcb(error);
                        return;
                    }

                    var uname_re = /^joyent_(\d{8}T\d{6}Z)$/m;

                    stdout = stdout.toString();

                    var match = stdout.trim().match(uname_re);
                    if (!match) {
                        wfcb(new VError(util.format(
                            'could not parse uname -v output: %j',
                            stdout)));
                        return;
                    }

                    self.liveimage = match[1];
                    wfcb();
                });
        },
        function (wfcb) {
            self.initializeHttpInterface(wfcb);
        },
        function _setupMetrics(wfcb) {
            // Since initializeHttpInterface() setup self.server, we can now
            // attach the metrics manager to that restify server instance.
            self.server.on('after', self.metricsManager.collectRestifyMetrics
                .bind(self.metricsManager));
            wfcb();
        },
        function (wfcb) {
            self.initializeConnections(wfcb);
        }
    ],
    function (error) {
        if (error) {
            self.log.error({ error: error },
                'Error during CNAPI start-up sequence');
            return;
        }
        self.log.info('Reached end of CNAPI start up sequence');
    });
};


App.prototype.startTaskCleaner = function (uuid) {
    var self = this;

    schedule();

    function schedule() {
        self.taskCleanerTimeout = setTimeout(
            cleanup, TASK_CLEANUP_PERIOD * 1000);
    }

    function cleanup() {
        schedule();

        var ts = Date.now();
        var then = ts - TASK_CLEANUP_MAX_AGE * 1000;
        var thenDate = new Date(then);
        var escts = common.filterEscape(thenDate.toISOString());
        self.log.warn('cleaning up tasks with timestamp older than = %s',
                      escts);

        var filter = sprintf('(!(timestamp>=%s))', escts);

        var moray = ModelWaitlist.getMoray();

        moray.deleteMany(buckets.tasks.name, filter, function (error) {
            if (error) {
                self.log.error(error, 'failed to clean up tasks older than %s',
                               thenDate.toISOString());
                return;
            }
        });
    }
};


/**
 * When we startup, we need to look for any servers that are unsetup and have
 * state=running. When operating normally, unsetup servers should be blasting
 * their sysinfo into the rabbit blackhole every 60s. If a server is broken
 * it might not be doing that. So we set an initial timer. If a sysinfo comes
 * in, this timer will be cleared and no changes will be made. If no sysinfo
 * comes in by the timer expiry, the server will be marked with "state=unknown".
 * It should be fine to do this in all CNAPIs even when we have multiple since
 * Ur blasts to all of them. Once we finally rid ourselves of Ur, we can get rid
 * of all this mess.
 */
App.prototype._startUnsetupTimers = function _startUnsetupTimers() {
    var self = this;

    var filter = '(&(setup=false)(status=running))';
    var findOpts = {};
    var req;
    var servers = [];

    function _onError(error) {
        self.log.error(error,
            'Unable to retrieve list of running unsetup server');

        // XXX Not much more we can do. We might end up with some unsetup+broken
        // servers with state "running" that should be "unknown" here, but we're
        // already in an edge case, and once those servers are fixed, they'll
        // show up correctly.
    }

    function _onRecord(server) {
        servers.push(server.value.uuid);
    }

    function _onEnd() {
        var idx;
        var serverUuid;

        for (idx = 0; idx < servers.length; idx++) {
            serverUuid = servers[idx];

            self.log.debug({serverUuid: serverUuid},
                'setting timer for unsetup server');
            self._setSysinfoTimer(serverUuid, null);
        }
    }

    function _onMorayConnection() {
        req = self.moray.getClient().findObjects(
            buckets.servers.name,
            filter,
            findOpts);

        req.on('error', _onError);
        req.on('record', _onRecord);
        req.on('end', _onEnd);
    }

    function waitThenFindRunningUnsetupServers() {
        async.until(
            function () {
                return self.moray.connected;
            }, function (cb) {
                setTimeout(cb, 1000);
            }, _onMorayConnection);
    }

    waitThenFindRunningUnsetupServers();
};


/**
 * This will start our HTTP service and allow us to respond to HTTP requests.
 */

App.prototype.initializeHttpInterface = function (callback) {
    var self = this;

    http.globalAgent.maxSockets = self.config.maxHttpSockets || 100;
    https.globalAgent.maxSockets = self.config.maxHttpSockets || 100;

    self.log.info('Initializing HTTP interface');

    self.server = createServer({
        app: self,
        log: self.log
    });

    self.server.listen(self.config.api.port, function () {
        self.log.info(
            '%s listening at %s',
            self.server.name,
            self.server.url);
    });
    return callback();
};


App.prototype.initializeConnections = function (callback) {
    var self = this;

    self.setupMorayClient();
    self.setupWorkflowClient();
    self.setupWaitlistDirector();
    self.setupServerHeartbeatReconciler();

    self.setupAmqpClient();
    self.startTaskCleaner();
    self._startUnsetupTimers();

    callback();
};


/**
 * Starts the timer for the updater that will periodically check whether there
 * are servers that have started or stopped heartbeating to this CNAPI and
 * update the status accordingly (the heartbeat reconciler).
 */

App.prototype.setupServerHeartbeatReconciler =
function setupServerHeartbeatReconciler() {
    var self = this;

    wait();

    function wait() {
        async.until(
            function () {
                return self.moray.connected;
            }, function (cb) {
                setTimeout(cb, 1000);
            }, onMorayConnection);
    }

    function onMorayConnection() {
        self.heartbeatReconciler = new HeartbeatReconciler({
            app: self,
            log: self.log,
            metricsManager: self.metricsManager,
            moray: self.moray.getClient()
        });

        // Start a timer to periodically check and update the cnapi_status
        // bucket, and the servers' 'status' fields.
        self.resetPeriodicHeartbeatReconcilerTimer();
    }
};


App.prototype.resetPeriodicHeartbeatReconcilerTimer =
function AppResetPeriodicHeartbeatReconcilerTimer() {
    var self = this;
    self.periodicHeartbeatHeartbeatReconcilerTimer =
        setTimeout(function () {
            self.heartbeatReconciler.reconcile(function _onReconciled() {
                // Reschedule the timer each time the heartbeats are reconciled.
                self.resetPeriodicHeartbeatReconcilerTimer();
            });
        }, common.HEARTBEAT_RECONCILIATION_PERIOD_SECONDS * 1000);
};


App.prototype.setupWaitlistDirector = function () {
    var self = this;

    var wldOpts = {
        cnapiUuid: self.uuid,
        log: self.log
    };

    self.waitlistDirector = new ModelWaitlist.createWaitlistDirector(wldOpts);
    async.until(function () {
        return self.moray.connected;
    },
    function (cb) {
        setTimeout(cb, 1000);
    },
    function () {
        self.log.info('Starting waitlist director');
        self.waitlistDirector.start();
    });
};


App.prototype.setupAmqpClient = function () {
    var self = this;
    var connection = self.amqpConnection
        = amqp.createConnection(self.config.amqp, { log: self.log });

    connection.on('ready', function () {
        connection.connected = true;
        self.log.info('AMQP connection ready');

        self.moray.ensureClientReady(function () {

            self.ur.useConnection(self.amqpConnection);
            self.ur.bindQueues();
        });
    });

    connection.on('error', function (e) {
        connection.connected = false;
        self.log.error(e);
    });

    connection.on('end', function () {
        connection.connected = false;
    });

    // Set up Ur client.
    self.log.debug('Ready to communicate with ur');
    self.ur = new Ur({ log: self.log });
    self.ur.on('serverSysinfo', self.onSysinfoReceivedUr.bind(self));
};


App.prototype.setupWorkflowClient = function () {
    var self = this;
    var config = {
        workflows: [
            'server-setup',
            'server-factory-reset',
            'server-reboot',
            'server-update-nics'
        ],
        url: self.config.wfapi.url,
        log: this.log,
        path: __dirname + '/workflows',

        forceReplace: true
    };

    this.workflow = new Workflow({
        config: config,
        log: this.log
    });

    this.workflow.startAvailabilityWatcher();

    // Don't proceed with initializing workflows until we have connected.
    function init() {
        async.until(
            function () { return self.workflow.connected; },
            function (cb) {
                setTimeout(cb, 1000);
            },
            function () {
                self.workflow.getClient().initWorkflows(function (error) {
                    if (error) {
                        self.log.error(error, 'Error initializing workflows');
                        init();
                    }
                    self.log.info('Initialized workflows');
                });
            });
    }

    init();
};


App.prototype.setupMorayClient = function () {
    var self = this;

    self.moray = new Moray({
        collector: self.metricsManager.collector, // the artedi handle
        config: self.config,
        log: self.log
    });

    self.moray.connect();
};


App.prototype.onStatusUpdate = function onStatusUpdate(opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.params, 'opts.params');
    assert.object(opts.serverModel, 'opts.serverModel');
    assert.func(callback, 'callback');

    var serverModel = opts.serverModel;
    var statusUpdate = opts.params;

    self.log.trace(statusUpdate, 'Status update');
    if (!callback) {
        callback = function () {};
    }

    if (! statusUpdate.vms) {
        statusUpdate.vms = {};
    }

    self.log.trace('Status update (%s) received -- %d zones.',
        serverModel.uuid, Object.keys(statusUpdate.vms).length);

    serverModel.updateFromStatusUpdate(
        statusUpdate,
        function (updateError) {
            if (updateError) {
                self.log.error(new VError(updateError,
                    'Updating server record from status update'));
                // Note: we don't fail here or return an error since these
                // messages are sent every 60 seconds so if one fails, we'll
                // get the updated state next time.
            }

            callback();
        });
};

App.prototype._setSysinfoTimer =
function _setSysinfoTimer(serverUuid, lastSeen) {
    var self = this;

    if (!self.unsetupServers[serverUuid]) {
        self.unsetupServers[serverUuid] = {};
    }
    self.unsetupServers[serverUuid].lastUrSysinfo = lastSeen;
    self.unsetupServers[serverUuid].sysinfoTimer =
        setTimeout(function _markUnknown() {
            if (self.observedHeartbeats[serverUuid]) {
                self.log.info({
                    serverUuid: serverUuid
                }, 'Server is heartbeating. No longer relying on Ur sysinfo ' +
                    'messages to set status');
                return;
            }

            self.log.warn('No sysinfo for %d seconds, ' +
                'marking status="unknown"',
                UNSETUP_UR_SYSINFO_TIMEOUT_SECONDS);

            ModelServer.upsert(serverUuid, {status: 'unknown'}, {
                etagRetries: 0
            }, function _markedUnknown(markUnknownErr) {
                if (markUnknownErr) {
                    self.log.warn({
                        err: markUnknownErr,
                        serverUuid: serverUuid
                    }, 'failed to mark server "unknown"');
                }
            });
        }, UNSETUP_UR_SYSINFO_TIMEOUT_SECONDS * 1000);
};

App.prototype.onSysinfoReceivedUr =
function onSysinfoReceivedUr(message, routingKey) {
    var self = this;

    var serverUuid = routingKey.split('.')[2];
    var sysinfo = message;

    assert.equal(serverUuid, sysinfo['UUID'],
        'Ur routing key must match sysinfo.UUID');

    // When a server is unsetup and therefore does not have a cn-agent running
    // and sending heartbeats, we currently handle updating its status based on
    // the sysinfo messages that are emitted by Ur every 60 seconds. When we see
    // a sysinfo from an unsetup server we:
    //
    //  * clear existing timers
    //  * ensure the server record is created/updated
    //  * ensure the server record has status=running (it's alive!)
    //  * set a timer so that in 90 seconds if we haven't seen another sysinfo,
    //    we mark the status=unknown.
    //
    // This code should all be able to be removed (we can ignore all ur.sysinfo
    // messages) once cn-agent is automatically running on new servers.

    if (self.unsetupServers.hasOwnProperty(serverUuid)) {
        clearTimeout(self.unsetupServers[serverUuid].sysinfoTimer);
        if (sysinfo['Setup'].toString() === 'true') {
            // no longer unsetup!
            delete self.unsetupServers[serverUuid];
        }
    }

    ModelServer.updateFromSysinfo(sysinfo, function _onUpdate(err, server) {
        self.log.trace({
            err: err,
            serverUuid: serverUuid,
            sysinfo: sysinfo
        }, 'Got sysinfo from Ur and attempted update');

        if (self.observedHeartbeats[serverUuid]) {
            self.log.debug({
                serverUuid: serverUuid
            }, 'Server is heartbeating. Not setting status from Ur sysinfo ' +
                'message');
            return;
        }

        if (sysinfo['Setup'].toString() !== 'true') {
            ModelServer.upsert(serverUuid, {status: 'running'}, {
                etagRetries: 0
            }, function _markedRunning(markRunningErr) {
                if (markRunningErr) {
                    self.log.warn({
                        err: markRunningErr,
                        serverUuid: serverUuid
                    }, 'failed to mark server "running"');
                }

                // If we get another sysinfo before the timer expires, the
                // timeout will be cleared.
                self._setSysinfoTimer(serverUuid, Date.now());
            });
        }
    });
};


/* BEGIN JSSTYLED */
/*
 * Set a callback to be executed when a cn-agent task has completed. This
 * allows upstream clients to initiate a task and then wait for it to complete,
 * without needing to poll periodically.
 *
 * @param opts {Object}
 * @param opts.taskid {String}
 * @param opts.timeoutSeconds {Number} How long to wait before we consider this task timed out
 * @param callback {Function} Function to call on task completion
 */
/* END JSSTYLED */

App.prototype.waitForTask = function (opts, callback) {
    var self = this;
    var taskid = opts.taskid;
    var timeoutSeconds = opts.timeoutSeconds || 3600;

    assert.object(opts, 'opts');
    assert.string(opts.taskid, 'opts.taskid');
    assert.optionalNumber(opts.timeoutSeconds, 'opts.timeoutSeconds');
    assert.func(callback, 'callback');

    if (!self.taskCallbacks.hasOwnProperty(taskid)) {
        self.taskCallbacks[taskid] = {
            callbacks: []
        };
    }

    // Check if there is a cached response for this task.
    if (self.taskCallbacks[taskid].task) {
        self.log.debug({ cached: self.taskCallbacks[taskid].task },
            'waitForTask: returning a cached task value');
        callback(null, self.taskCallbacks[taskid].task);
        return;
    }

    self.log.debug('waitForTask: no cached value found');

    /**
     * Generate an id so we can find our way back to a particular callback when
     * it comes to time expire it.
     */
    var id = crypto.createHash('sha1').update(
                crypto.randomBytes(128)).digest('hex');

    var timeout = setTimeout(function () {
        for (var idx in self.taskCallbacks[taskid].callbacks) {
            if (self.taskCallbacks[taskid].callbacks[idx].id === id) {

                self.taskCallbacks[taskid].callbacks[idx].fn(new Error(
                    'wait timed out after ' + timeoutSeconds));

                // Remove the matching callback from the list
                self.taskCallbacks[taskid].callbacks.splice(idx, 1);

                if (self.taskCallbacks[taskid].callbacks.length === 0) {
                    delete self.taskCallbacks[taskid];
                }
                break;
            }

            if (self.taskCallbacks[taskid].callbacks.length === 0) {
                delete self.taskCallbacks[taskid];
            }
        }
    }, timeoutSeconds * 1000);

    var obj = { id: id, timeout: timeout, fn: once(callback) };
    self.taskCallbacks[taskid].callbacks.push(obj);
};


/**
 * This function is called when we want to let any waiting callbacks know that
 * a cn-agent task we initiated has completed.
 */

App.prototype.alertWaitingTasks = function (err, taskid, task) {
    var self = this;

    assert.optionalObject(err, 'err');
    assert.string(taskid, 'taskid');
    assert.object(task, 'task');

    /**
     * If no callbacks were set for this task response when we go to alert
     * waiting callbacks, cache the value in case we end up trying to wait for
     * this task to finish after it has already done so.
     *
     * This can happen if the task finishes after we do the initial 'get' for
     * the task, but before we can wait on it. In such a situation, we cache
     * the task values so we can return it for subsequent waits.
     */

    if (!self.taskCallbacks.hasOwnProperty(taskid) ||
            self.taskCallbacks[taskid].callbacks.length === 0)
    {
        self.log.debug(
            'alertWaitingTasks: wanted to alert callbacks for task %s, '
            + 'but none found, caching response', taskid);

        var timeout = setTimeout(function () {
            delete self.taskCallbacks[taskid];
        }, TASK_CLEANUP_PERIOD * 1000).unref();

        self.taskCallbacks[taskid] = {
            task: task,
            callbacks: [],

            /**
             * This timer ensures this cached value gets cleaned-up if no one
             * checks and disposes of it before the expiry.
             */
            cleanupTimeout: timeout
        };

        return;
    }

    var toAlert = self.taskCallbacks[taskid].callbacks;

    for (var idx in toAlert) {
        clearTimeout(toAlert[idx].timeout);
        toAlert[idx].fn(err, task);
    }

    delete self.taskCallbacks[taskid];
};


/**
 * Moray
 */

App.prototype.getMoray = function () {
    return this.moray.getClient();
};


App.prototype.setMoray = function (moray) {
    this.moray = moray;
    return this.moray;
};


/**
 * Workflow
 */

App.prototype.getWorkflow = function () {
    return this.workflow;
};


App.prototype.setWorkflow = function (workflow) {
    this.workflow = workflow;
};


/**
 * Ur
 */

App.prototype.getUr = function () {
    return this.ur;
};


App.prototype.setUr = function (ur) {
    this.ur = ur;
    return ur;
};


/**
 * Misc
 */


App.prototype.getConfig = function () {
    return this.config;
};


App.prototype.getLog = function (callback) {
    return this.log;
};


module.exports = App;
