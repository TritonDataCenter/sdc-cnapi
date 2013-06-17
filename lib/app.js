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
var WorkflowClient = require('wf-client');

var amqp = require('./amqp-plus');
var buckets = require('./apis/moray').BUCKETS;
var common = require('./common');
var createServer = require('./server').createServer;
var Heartbeater = require('./heartbeater');
var ModelBase = require('./models/base');
var ModelPlatform = require('./models/platform');
var ModelServer = require('./models/server');
var ModelVM = require('./models/vm');
var Moray = require('./apis/moray');
var Redis = require('./apis/redis');
var Ur = require('./ur');
var Workflow = require('./apis/workflow');

function App(config) {
    var self = this;

    self.config = config;
    self.tasks = {};
    self.connectionStatus = {};

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
     * this.startTs = (new Date()).toISOString();
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


App.prototype.start = function () {
    var self = this;

    async.waterfall([
        function (callback) {
            self.initializeHttpInterface(callback);
        },
        function (callback) {
            self.initializeAmqp(callback);
        },
        function (callback) {
            self.connectToServiceDependencies(callback);
        },
        function (callback) {
            self.initializeUr(callback);
        },
        function (callback) {
            self.ur.useConnection(self.amqpConnection);
            self.useConnection(self.amqpConnection);

            self.amqpConnection.reconnect();
            callback();
        },
        function (callback) {
            self.initializeHeartbeater(callback);
        }
    ],
    function (error) {
        self.log.info('Reached end of CNAPI start up sequence');
    });
};


App.prototype.connectToServiceDependencies = function (callback) {
    var self = this;

    self.log.info('Connecting to APIs');

    self.connect(function (error) {
        if (error) {
            self.log.error(error, 'Error initializing model connections');
            callback(error);
            return;
        }

        self.initializeBuckets(callback);
    });
};


/**
 * Connect the model instance to storange and API backends.
 */

App.prototype.connect = function (callback) {
    var self = this;

    async.waterfall([
        function (cb) {
            self.redisClientCreate(cb);
        },
        function (cb) {
            self.taskClientCreate(cb);
        },
        function (cb) {
            self.morayClientCreate(cb);
        },
        function (cb) {
            self.workflowClientCreate(cb);
        },
        function (cb) {
            self.moray.getClient(cb);
        },
        function (cb) {
            self.redis.getClient(cb);
        }
    ],
    function (error) {
        if (error) {
            self.log.error(error);
            return callback(error);
        }
        self.log.debug('Model connected');
        return callback();
    });
};


/**
 * Disconnect model instance from storage and API backends.
 */

App.prototype.disconnect = function (callback) {
    this.taskClient.end();
};


/**
 * Pass in an AMQP connection object to be used by model.
 */
App.prototype.useConnection = function (connection) {
    this.taskClient.useConnection(connection);
};


/**
 * Create a provisioner task client instance.
 */
App.prototype.taskClientCreate = function (callback) {
    var self = this;
    this.taskClient = new TaskClient(self.config);
    callback();
};


App.prototype.initializeBuckets = function (callback) {
    var self = this;
    var moray = this.moray.getClient();

    self.log.info('Initializing buckets');
    async.waterfall([
        function (cb) {
            self.moray.ensureClientReady(cb);
        },
        function (cb) {
            moray.getBucket(buckets.servers.name, function (error, bucket) {
                if (error) {
                    if (error.name === 'BucketNotFoundError') {
                        self.log.info(
                            'Moray bucket \'%s\', does not yet exist. Creating'
                            + ' it.', buckets.servers.name);
                        moray.createBucket(
                            buckets.servers.name, buckets.servers.bucket, cb);
                        return;
                    } else {
                        self.log.info(
                            'Moray bucket error, %s, exists.', error.message);
                        cb(error);
                        return;
                    }
                }
                self.log.info(
                    'Ensuring moray bucket %s up to date',
                    buckets.servers.name);
                moray.updateBucket(
                    buckets.servers.name, buckets.servers.bucket, cb);
            });
        },
        function (cb) {
            // Check for 'default' server object
            moray.getObject(
                buckets.servers.name,
                'default',
                function (error, obj) {
                    if (error) {

                        if (error.name === 'ObjectNotFoundError') {
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


App.prototype.redisClientCreate = function (callback) {
    this.redis = new Redis({
        log: this.log,
        config: this.config.redis
    });
    callback();
};


App.prototype.morayClientCreate = function (callback) {
    this.moray = new Moray({
        log: this.log,
        config: this.config
    });
    callback();
};


App.prototype.workflowClientCreate = function (callback) {
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
    async.until(
        function () { return self.workflow.connected; },
        function (cb) {
            setTimeout(cb, 1000);
        },
        function () {
            self.workflow.getClient().initWorkflows(function (error) {
                if (error) {
                    self.log.error(error, 'Error initializing workflows');
                }
            });
        });

    callback();
};


/**
 * Redis
 */

App.prototype.getRedis = function () {
    return this.redis.getClient();
};


App.prototype.setRedis = function (redis) {
    this.redis = redis;
    return redis;
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


App.prototype.initializeAmqp = function (callback) {
    var self = this;
    var connection = self.amqpConnection
        = amqp.createConnection(self.config.amqp, { log: self.log });

    connection.on('ready', function () {
        self.collectGlobalSysinfo();
    });

    callback();
    return;
};


/**
 * Execute this function whenever a heartbeat is received from a server.
 */

App.prototype.onHeartbeat = function (heartbeat, routingKey) {
    var self = this;
    var uuid = routingKey.split('.')[1];
    self.log.trace('Heartbeat (%s) received -- %d zones.',
        uuid, heartbeat.zoneStatus[0].length);

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


App.prototype.initializeHeartbeater = function (callback) {
    var self = this;

    self.log.info('Listening for heartbeats');
    self.heartbeater = new Heartbeater({ log: self.log });
    self.heartbeater.useConnection(self.amqpConnection);
    if (callback) {
        callback();
    }
};


App.prototype.initializeUr = function (callback) {
    var self = this;
    self.ur = new Ur({ log: self.log });
    self.ur.on('serverStartup', self.onServerStartup.bind(self));
    self.ur.on('serverSysinfo', self.onServerSysinfo.bind(self));
    callback();
    return;
};


App.prototype.collectGlobalSysinfo = function () {
    var self = this;
    self.ur.broadcastSysinfo(function (error, sysinfoCollection) {
        async.forEach(
            sysinfoCollection,
            function (sysinfo, cb) {
                self.refreshServerFromSysinfo(sysinfo, cb);
                ModelServer.beginSysinfoWorkflow(sysinfo);
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


/**
 * Given a sysinfo object, this function will check if the server exists in
 * Moray. Because the sysinfo message is sent only on start-up, if the server
 * does exist in Moray, we will update the record with the most recent
 * information.
 * If the server does not exist, it will be created in Moray. In either case,
 * the Redis server cache will be updated to reflect that we currently know
 * about this server.
 */

App.prototype.refreshServerFromSysinfo =
function (sysinfo, callback) {
    var self = this;

    var uuid = sysinfo['UUID'];

    var lastboot;

    if (sysinfo['Boot Time']) {
        lastboot = new Date(Number(sysinfo['Boot Time']) * 1000).toISOString();
    }

    /**
     * We need to check if these attributes exist in sysinfo, if not
     * we need to look them up via Ur.
     */
    var zpool = {
        'Zpool': null,
        'Zpool Disks': null,
        'Zpool Profile': null,
        'Zpool Size in GiB': null
    };

    if (!sysinfo.hasOwnProperty('Zpool')) {
    
    }

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
        self.log.info('Finished processing server (%s) sysinfo');
        callback();
    });


    function onServerExists() {
        ModelServer.updateServerPropertiesFromSysinfo({
            sysinfo: sysinfo,
            server: server
        });

        server.sysinfo = sysinfo;

        if (lastboot) {
            server.last_boot = lastboot;
        }

        server.current_platform = sysinfo['Live Image'];
        server.hostname = sysinfo['Hostname'];
        server.transitional_status = '';

        self.log.info('Server %s existed in moray', uuid);
        self.log.debug({sysinfo: sysinfo });

        // Check for SDC 6.5 server which didn't have a Setup flag. If no
        // such flag is present, we will attempt to check the server's
        // zpools via sysinfo.
        if (!server.setup && !sysinfo.hasOwnProperty('Setup')) {
            self.log.warn('Cannot determine setup state of machine');
            inspectServer(function (error, isSetup, lastBoot) {
                if (error) {
                    self.log.error(error);
                }
                lastboot = (new Date(lastBoot * 1000)).toISOString();
                if (isSetup) {
                    server.setup = true;
                } else {
                    server.setup = false;
                }
                modify(cb);
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
            modify(cb);
        } else {
            modify(cb);
        }

    }

    function onServerDoesNotExist() {
        self.log.info('Server %s has \'Setup\' sysinfo'
            + ' property, set to \'%s\'', sysinfo['UUID'],
            sysinfo['Setup']);
        if (sysinfo['Setup']) {
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
            create({ setup: setup });
            return;
        } else {
            self.log.info(
                'Server %s not found in moray, does not'
                + ' contain sysinfo \'Setup\' property',
                uuid);
            inspectServer(function (error, isSetup, lastBoot) {
                if (error) {
                    self.log.error(error);
                }
                lastboot = (new Date(lastBoot * 1000)).toISOString();
                if (isSetup) {
                    create({ setup: true });
                } else {
                    create({ setup: false });
                }
            });
        }
    }

    function inspectServer(cb) {
        self.log.info('Looking up zpools, boot_time on server (%s) via Ur', uuid);

        fs.readFile(
            __dirname + '../../share/inspect-server.sh',
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
                    var vals;
                    try {
                        vals = stdout.toString();
                    } catch (e) {
                        cb(new Error(
                            'Error: parsing inspect payload from server'));
                        return;
                    }

                    var numPools = vals.zpools.length;
                    var bootTime = vals.boot_time;

                    self.log.warn('Machine had %d zpools', numPools);
                    if (numPools > 0) {
                        self.log.warn(
                            'Server %s appeared to be setup (had %d pools)',
                            uuid, numPools);
                        cb(null, { isSetup: true, lastBoot: bootTime });
                    } else {
                        self.log.warn(
                            'Server %s appeared to not to be setup'
                            + ' (had %d pools)',
                            uuid, numPools);
                        cb(null, { isSetup: false, lastBoot: bootTime });
                    }
                });
        });
    }

    function create(opts) {
        ModelServer.getBootParamsDefault(
            function (error, params) {
                serverModel.create(
                    {
                        boot_params: params,
                        setup: opts.setup,
                        sysinfo: sysinfo,
                        last_boot: lastboot
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
                    self.log.info('Modified server record');
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
    self.log.info('Ur startup message received from %s', uuid);
    self.log.trace(message);

    ModelServer.beginSysinfoWorkflow(message);

    self.refreshServerFromSysinfo(
        message,
        function (error) {
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
    self.log.trace('Ur sysinfo message received from %s', uuid);
    self.log.trace(message);

    var serverModel = new ModelServer(uuid);

    serverModel.cacheSetServerStatus(
        'running',
        90,
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

module.exports = App;
