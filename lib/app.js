/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This is where the core of CNAPI abstractions and logic is defined:
 */

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var execFile = require('child_process').execFile;
var fs = require('fs');
var http = require('http');
var https = require('https');
var Logger = require('bunyan');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var TaskClient = require('task_agent/lib/client');
var util = require('util');
var verror = require('verror');
var nedb = require('nedb');
var WorkflowClient = require('wf-client');
var deepEqual = require('deep-equal');

var amqp = require('./amqp-plus');
var common = require('./common');
var createServer = require('./server').createServer;
var Heartbeater = require('./heartbeater');
var ModelBase = require('./models/base');
var ModelPlatform = require('./models/platform');
var ModelServer = require('./models/server');
var ModelVM = require('./models/vm');
var Moray = require('./apis/moray');
var Ur = require('./ur');
var Workflow = require('./apis/workflow');

function App(config) {
    var self = this;

    self.config = config;

    self.config.log = self.log = new Logger({
        name: 'cnapi',
        level: config.logLevel,
        serializers: {
            err: Logger.stdSerializers.err,
            req: Logger.stdSerializers.req,
            res: Logger.stdSerializers.res
        }
    });

    /*
     * var memwatch = require('memwatch');
     * this.leaks = [];
     * this.stats = [];
     * this.diff = {};
     * var maxStats = 16;
     * this.initialHeapDiff = new memwatch.HeapDiff();
     *
     * // Allow CNAPI to settle before initiating memory watching
     * setTimeout(function () {
     *     self.log.info('Initiating memwatch for leaks');
     *     memwatch.on('leak', function (leak) {
     *         self.log.warn(leak, 'memwatch leak event');
     *         self.leaks.push(leak);
     *         self.diff = self.initialHeapDiff.end();
     *     });
     *     memwatch.on('stats', function (stats) {
     *         self.log.info(stats, 'memwatch stats event');
     *         if (self.stats.length > maxStats) {
     *             self.stats.pop();
     *         }
     *         stats.timestamp = (new Date()).toISOString();
     *         self.stats.unshift(stats);
     *     });
     * }, 60*1000);
     */

    ModelBase.init(self);
    ModelPlatform.init(self);
    ModelServer.init(self);
    ModelVM.init(self);
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
 * Once connected to all of the above we may:
 * - Begin listening for heartbeats
 * - Request sysinfo for compute nodes via Ur
 */

App.prototype.start = function () {
    var self = this;

    self.start_timestamp = (new Date()).toISOString();

    async.waterfall([
        function (callback) {
            self.initializeHttpInterface(callback);
        },
        function (callback) {
            self.initializeConnections(callback);
        }
    ],
    function (error) {
        self.log.info('Reached end of CNAPI start up sequence');
    });
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

    self.setupAmqpClient();

    callback();
};


App.prototype.setupAmqpClient = function () {
    var self = this;
    var connection = self.amqpConnection
        = amqp.createConnection(self.config.amqp, { log: self.log });

    connection.on('ready', function () {
        self.moray.ensureClientReady(function () {
            self.collectGlobalSysinfo();
        });
    });

    // Set up Ur client.
    self.log.debug('Ready to communicate with ur');
    self.ur = new Ur({ log: self.log });
    self.ur.on('serverStartup', self.onServerStartup.bind(self));
    self.ur.on('serverSysinfo', self.onServerSysinfo.bind(self));
    self.ur.useConnection(self.amqpConnection);

    // Set up provisioner task client.
    self.log.debug('Ready to communicate with provisioner');
    this.taskClient = new TaskClient(self.config);
    this.taskClient.useConnection(connection);

    // Set up the heartbeat listener.
    self.log.debug('Ready to listen for heartbeats');
    self.heartbeater = new Heartbeater({ log: self.log });
    self.heartbeater.useConnection(self.amqpConnection);

    // Open the connection.
    self.amqpConnection.reconnect();
};


App.prototype.setupWorkflowClient = function () {
    var self = this;
    var config = {
        workflows: [
            'server-setup',
            'server-factory-reset',
            'server-sysinfo',
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
    this.moray = new Moray({
        log: this.log,
        config: this.config
    });
    this.moray.connect();
};


/**
 * Execute this function whenever a heartbeat is received from a server.
 */

App.prototype.onHeartbeat = function (heartbeat, routingKey) {
    var self = this;
    var uuid = routingKey.split('.')[1];
    self.log.trace('Heartbeat (%s) received -- %d zones.',
        uuid, Object.keys(heartbeat.vms).length);

    if (!self.amqpConnection.connected) {
        self.log.warn(
            'Cannot refresh server from heartbeat: cannot reach moray');
        return;
    }

    self.refreshServerFromHeartbeat(
        uuid,
        heartbeat,
        function (refreshError, server) {
            if (refreshError) {
                self.log.error(
                    refreshError,
                    'Error refreshing server\'s record');
                return;
            }
        });
};


App.prototype.collectGlobalSysinfo = function () {
    var self = this;
    self.ur.broadcastSysinfo(function (error, sysinfoCollection) {
        async.forEach(
            sysinfoCollection,
            function (sysinfo, cb) {

                var s = new ModelServer(sysinfo['UUID']);
                s.getRaw(function (err, values) {
                    if (!values || !deepEqual(values.sysinfo, sysinfo)) {
                        self.log.info(
                            'Server sysinfo for %s has changed. Initiating ' +
                            'server-sysinfo workflow',
                            sysinfo['UUID']);
                        ModelServer.beginSysinfoWorkflow(sysinfo);
                    } else {
                        self.log.debug(
                            'Server sysinfo for %s has not changed. ' +
                            'Skipping server-sysinfo workflow',
                            sysinfo['UUID']);
                    }
                });

                self.refreshServerFromSysinfo(sysinfo, cb);
            },
            function (err) {
                if (err) {
                    self.log.error(
                        'Error updating server record from global'
                        + ' broadcast: %s',
                        err.message);
                }
                self.heartbeater.on('heartbeat', self.onHeartbeat.bind(self));
            });
    });
};


/**
 * Given a sysinfo object, this function will check if the server exists in
 * Moray. Because the sysinfo message is sent only on start-up, if the server
 * does exist in Moray, we will update the record with the most recent
 * information.
 * If the server does not exist, it will be created in Moray. In either case,
 * the cache will be updated to reflect that we currently know about this
 * server.
 */

App.prototype.refreshServerFromSysinfo =
function (sysinfo, refreshcb) {
    var self = this;

    if (!refreshcb) {
        refreshcb = function () {};
    }

    if (!self.moray.connected) {
        self.log.warn(
            'Cannot refresh server from sysinfo: cannot reach moray');
        refreshcb();
        return;
    }

    var uuid = sysinfo['UUID'];

    var sysinfoCarryOverParams = [
        'Zpool', 'Zpool Creation', 'Zpool Disks',
        'Zpool Profile', 'Zpool Size in GiB'];

    var lastboot, created;

    if (sysinfo['Boot Time']) {
        lastboot = new Date(Number(
            sysinfo['Boot Time']) * 1000).toISOString();
    }

    if (sysinfo['Zpool Creation']) {
        created = new Date(Number(
            sysinfo['Zpool Creation']) * 1000).toISOString();
    }

    var shouldInspectServer = false;
    var serverModel = new ModelServer(uuid);
    var server;

    async.waterfall([
        function (cb) {
            serverModel.getRaw(function (getError, s) {
                if (getError) {
                    self.log.error(
                        getError, 'Error fetching server %s from Moray', uuid);
                    cb(getError);
                    return;
                }
                server = s;
                cb();
            });
        },
        function (cb) {
            if (serverModel.exists) {
                onServerExists(cb);
            } else {
                onServerDoesNotExist(cb);
            }
        }
    ],
    function (error) {
        self.log.debug('Finished processing server (%s) sysinfo', uuid);
        refreshcb();
    });


    function onServerExists(callback) {
        // These parameters, if they exist in the currently stored sysinfo must
        // be copied from the current sysinfo into the new one.
        for (var keyIdx in sysinfoCarryOverParams) {
            var key = sysinfoCarryOverParams[keyIdx];

            if (server.hasOwnProperty('sysinfo') &&
                    server.sysinfo.hasOwnProperty(key))
            {
                sysinfo[key] = server.sysinfo[key];
            }
        }

        ModelServer.updateServerPropertiesFromSysinfo({
            sysinfo: sysinfo,
            server: server
        });

        if (lastboot) {
            server.last_boot = lastboot;
        }

        if (created) {
            server.created = created;
        }

        server.current_platform = sysinfo['Live Image'];
        server.hostname = sysinfo['Hostname'];
        server.transitional_status = '';

        self.log.info('Server %s existed in moray', uuid);
        self.log.debug({sysinfo: sysinfo });

        async.waterfall([
            function (cb) {
                if (!server.setup && !sysinfo.hasOwnProperty('Setup')) {
                    shouldInspectServer = true;
                }

                if (!server.sysinfo ||
                    !server.sysinfo.hasOwnProperty('Zpool') ||
                    !sysinfo.hasOwnProperty('Zpool') ||
                    !sysinfo.hasOwnProperty('Zpool Creation'))
                {
                    shouldInspectServer = true;
                }

                cb();
            },
            function (cb) {
                if (shouldInspectServer) {
                    inspectServer(function (error, values) {
                        if (error) {
                            self.log.error(error);
                        }

                        lastboot = (
                            new Date(values.boot_time * 1000))
                            .toISOString();

                        created = (
                            new Date(values.zpool_creation * 1000))
                            .toISOString();

                        var setup = server.setup ||
                            (server.sysinfo['Setup'] == 'true' ? true : false);

                        if (values.zpool) {
                            server.sysinfo['Zpool'] = values.zpool;
                            server.sysinfo['Zpool Disks'] = values.zpool_disks;
                            server.sysinfo['Zpool Creation']
                                = values.zpool_creation;
                            server.sysinfo['Zpool Profile']
                                = values.zpool_profile;
                            server.sysinfo['Zpool Size in GiB']
                                = values.zpool_size;
                            setup = true;
                        }

                        server.setup = setup;

                        cb();
                    });
                } else if (sysinfo.hasOwnProperty('Setup')) {
                    self.log.info('Server %s has \'Setup\' sysinfo'
                            + ' property, set to \'%s\'', sysinfo['UUID'],
                            sysinfo['Setup']);
                    if (sysinfo['Setup'] === false ||
                            sysinfo['Setup'] === 'false')
                    {
                        server.setup = false;
                    } else if (sysinfo['Setup'] === true ||
                            sysinfo['Setup'] === 'true')
                    {
                        server.setup = true;
                    }
                    cb();
                } else {
                    cb();
                }
            }
        ],
        function (error) {
            modify(callback);
        });
    }

    function onServerDoesNotExist(callback) {
        if (!sysinfo['Setup']) {
            self.log.info('New server %s missing sysinfo.Setup', uuid);
            shouldInspectServer = true;
        }

        if (!sysinfo['Zpool']) {
            self.log.info('New server %s missing sysinfo.Zpool', uuid);
            shouldInspectServer = true;
        }

        if (!sysinfo['Zpool Creation']) {
            self.log.info(
                'New server %s missing sysinfo["Zpool Creation"]', uuid);
            shouldInspectServer = true;
        }

        if (shouldInspectServer) {
            inspectServer(function (error, values) {
                if (error) {
                    self.log.error(error);
                }
                lastboot = (
                    new Date(values.boot_time * 1000))
                    .toISOString();

                created = (
                    new Date(values.zpool_creation * 1000))
                    .toISOString();

                if (values.zpool) {
                    create({ setup: true, inspect: values }, callback);
                } else {
                    create({ setup: false, inspect: values }, callback);
                }
            });
        } else {
            var setup = false;
            if (sysinfo['Boot Parameters']['headnode'] === 'true' ||
                sysinfo['Setup'] === true ||
                sysinfo['Setup'] === 'true')
            {
                setup = true;
            } else if (sysinfo['Setup'] === false ||
                sysinfo['Setup'] === 'false')
            {
                setup = false;
            }
            create({ setup: setup }, callback);
            return;
        }
    }


    function inspectServer(cb) {
        self.log.info(
            'Looking up zpools, boot_time on server (%s) via Ur', uuid);

        fs.readFile(
            __dirname + '/../share/inspect-server.sh',
        function (readerror, script) {
            if (readerror) {
                cb(readerror);
                return;
            }

            serverModel.invokeUrScript(
                script.toString(),
                { uuid: uuid },
                function (error, stdout, stderr) {
                    if (error) {
                        self.log.error(
                            'Error fetching list of pools from server %s:' +
                            ' %s', uuid, stderr);
                        cb(error);
                        return;
                    }
                    var values;
                    try {
                        values = JSON.parse(stdout.toString());
                    } catch (e) {
                        cb(new Error(
                            'Error: parsing inspect payload from server'));
                        return;
                    }

                    cb(null, values);
                });
        });
    }


    function create(opts, callback) {
        ModelServer.getBootParamsDefault(
            function (error, params) {
                if (opts.inspect) {
                    // These parameters, if they exist in the currently stored
                    // sysinfo must be copied from the current sysinfo into the
                    // new one.

                    if (opts.inspect.zpool) {
                        sysinfo['Zpool'] = opts.inspect.zpool;
                        sysinfo['Zpool Disks'] = opts.inspect.zpool_disks;
                        sysinfo['Zpool Profile']
                            = opts.inspect.zpool_profile;
                        sysinfo['Zpool Size in GiB']
                            = opts.inspect.zpool_size;
                        opts.setup = true;
                    }
                }
                serverModel.create(
                    {
                        boot_params: params,
                        setup: opts.setup,
                        sysinfo: sysinfo,
                        last_boot: lastboot,
                        created: created
                    },
                    function (err, s) {
                        if (err) {
                            self.log.error(err,
                                'Error getting default parameters');
                            callback(err);
                            return;
                        }
                        self.log.debug('Cached server in memory');
                        serverModel.cacheSetServer(
                            s,
                            function (updateError) {
                                if (updateError) {
                                    self.log.error(
                                        updateError,
                                        'Error updating server cache');
                                    self.log.error(util.inspect(s));
                                    callback(updateError);
                                    return;
                                }
                                callback();
                        });
                    });
            });
    }


    function modify(cb) {
        if (lastboot) {
            server.last_boot = lastboot;
        }
        if (created) {
            server.created = created;
        }
        serverModel.cacheSetServer(server, function (updateError) {
            if (updateError) {
                self.log.error(updateError, 'Error updating server cache');
                self.log.error(server, 'Object in question');
                cb(updateError);
                return;
            }
            serverModel.modify(
                server,
                function (modifyError) {
                    if (modifyError) {
                        self.log.error(
                            modifyError,
                            serverModel.errorFmt(
                                'modifying server record'),
                            uuid);
                        return;
                    }
                    self.log.debug('Modified server record');
                    cb();
                    return;
                });
        });
    }
};


/**
 * Take a UUID and a heartbeat object. If the server exists in the cache,
 * update the memory usage cache and the server VMs cache. If the server
 * doesn't exist in the cache, check if it exists in Moray. If it does
 * exist there, add the server to the servers cache and the VMs to the
 * server VMs cache. If the server does not exist in Moray, then create
 * the server in Moray and then add the appropriate values there.
 */

App.prototype.refreshServerFromHeartbeat =
function (uuid, heartbeat, callback) {
    var self = this;

    var serverModel = new ModelServer(uuid);

    if (!self.moray.connected) {
        self.log.warn('Cannot update server: received heartbeat but not ' +
            'connected to moray');
        callback();
        return;
    }

    serverModel.getRaw(function (getError, server) {
        if (getError) {
            self.log.error(getError, 'Error listing servers');
            callback(getError);
            return;
        }

        if (server) {
            async.parallel([
                function (cb) {
                    var modification = {
                        last_heartbeat: (new Date()).toISOString()
                    };

                    if (heartbeat.boot_time) {
                        modification.last_boot = (new Date(
                            heartbeat.boot_time * 1000)).toISOString();
                    }

                    serverModel.modify(modification, cb);
                },
                function (cb) {
                    serverModel.updateCacheFromHeartbeat(heartbeat, cb);
                }
            ],
            function () {
                self.log.trace('Server %s updated from heartbeat', uuid);
            });
        } else {
            var opts = { uuid: uuid, heartbeat: heartbeat };
            self.log.info(
                'Creating record for server %s  from heartbeat', uuid);
            serverModel.create(opts, callback);
        }
    });
};


/**
 * Execute this function whenver a sysinfo message is received via AMQP from
 * the Ur agent of a server which has started up.
 */

App.prototype.onServerStartup = function (message, routingKey) {
    var self = this;

    var uuid = routingKey.split('.')[2];
    self.log.info('Startup sysinfo message received from %s', uuid);
    self.log.trace(message);

    if (self.workflow.connected) {
        ModelServer.beginSysinfoWorkflow(message);
    } else {
        self.log.info({ uuid: uuid},
            'Could not create sysinfo workflow: workflow unavailable');
    }

    self.refreshServerFromSysinfo(message, function (error) {
        if (error) {
            self.log.error(
                error,
                'Error updating server from startup sysinfo');
            return;
        }
        self.log.info(message, 'Server %s startup sysinfo', uuid);
    });
};

/**
 * Compute nodes which are not in the 'setup' state, will periodically
 * broadcast their sysinfo payloads. On receipt of these messages, we will check
 * if we have any records of this server in the cache. If there are, we can
 * ignore this message (since we already a know about this server). If server
 * was not found in cache, check in moray. If it is found there, ignore
 * message. If it's not found in Moray, we need to add it.
 */

App.prototype.onServerSysinfo = function (message, routingKey) {
    var self = this;

    var uuid = routingKey.split('.')[2];
    self.log.debug('Ur sysinfo message received from %s', uuid);
    self.log.trace(message);

    var serverModel = new ModelServer(uuid);

    serverModel.cacheSetServerStatus(
        'running',
        function (cacheStatusError) {
        });

    serverModel.cacheCheckServerExists(function (error, exists) {
        if (error) {
            self.log.error(
                error, 'Error checking if server %s existed in cache.', uuid);
            return;
        }

        // Server found in cache, nothing to do here.
        if (exists) {
            return;
        }

        // Check in moray
        serverModel.getRaw(function (getError, server) {
            if (getError) {
                self.log.error(getError, 'Error listing servers');
                return;
            }

            if (!server) {
                // Check if server not found in Moray, let's add it.
                self.refreshServerFromSysinfo(
                    message,
                    function (refreshError) {
                        if (refreshError) {
                            self.log.error(
                                refreshError,
                                'Error updating server from startup sysinfo');
                            return;
                        }
                        self.log.info(
                            message, 'Server %s startup sysinfo', uuid);
                    });
            }
        });

    });
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
 * Task Client
 */

App.prototype.getTaskClient = function () {
    return this.taskClient;
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
