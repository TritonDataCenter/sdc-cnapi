/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * The main core of CNAPI is implemented here. Sets up the models, clients and
 * HTTP server.
 */

var amqp = require('./amqp-plus');
var async = require('async');
var Logger = require('bunyan');
var restify = require('restify');
var http = require('http');
var https = require('https');
var util = require('util');

var WorkflowClient = require('wf-client');

var createModel = require('./models').createModel;
var ModelServer = require('./models/server');
var createServer = require('./server').createServer;
var Heartbeater = require('./heartbeater');
var Ur = require('./ur');

function CNAPI(config) {
    this.config = config;
    this.servers = {};
    this.log = new Logger({
        name: 'cnapi',
        level: config.logLevel,
        serializers: {
            err: Logger.stdSerializers.err,
            req: Logger.stdSerializers.req,
            res: restify.bunyan.serializers.res
        }
    });
}

CNAPI.prototype.start = function () {
    var self = this;

    http.globalAgent.maxSockets = self.config.maxHttpSockets || 100;
    https.globalAgent.maxSockets = self.config.maxHttpSockets || 100;

    var modelOptions = {
        amqp_use_system_config: false,
        amqp: self.config.amqp,
        ufds: self.config.ufds,
        moray: self.config.moray,
        redis: self.config.redis,
        wfapi: self.config.wfapi,
        napi: self.config.napi,
        cnapi: self.config.cnapi,
        assets: self.config.assets,
        datacenter: self.config.datacenter_name,
        log: self.log
    };

    var urOptions = {
        log: self.log
    };

    self.config.log = self.log;
    self.log.info(self.modelOptions);

    var heartbeaterOptions = {
        log: self.log
    };

    async.waterfall([
        function (callback) {
            self.initializeAmqp(callback);
        },
        function (callback) {
            self.initializeModel(modelOptions, callback);
        },
        function (callback) {
            self.initializeUr(urOptions, callback);
            self.model.setUr(self.ur);
        },
        function (callback) {
            self.initializeHeartbeater(heartbeaterOptions, callback);
        },
        function (callback) {
            self.ur.useConnection(self.amqpConnection);
            self.heartbeater.useConnection(self.amqpConnection);
            self.model.useConnection(self.amqpConnection);

            self.amqpConnection.reconnect();
            callback();
        },
        function (callback) {
            self.model.initialize(callback);
        },
        function (callback) {
            var serverOptions = {
                model: self.model,
                log: self.log
            };
            self.initializeServer(serverOptions, callback);
        }
    ],
    function (error) {
        self.server.listen(self.config.api.port, function () {
            self.log.info(
                '%s listening at %s',
                self.server.name,
                self.server.url);
        });
    });
};


CNAPI.prototype.initializeAmqp = function (callback) {
    var self = this;
    var connection = self.amqpConnection
        = amqp.createConnection(self.config.amqp, { log: self.log });

    connection.on('ready', function () {
        self.collectGlobalSysinfo();
    });

    callback();
    return;
};


CNAPI.prototype.initializeModel = function (options, callback) {
    var self = this;

    self.log.info('Initializing model and connecting to ufds');

    var model = self.model = createModel(options);
    model.connect(function (error) {
        if (error) {
            self.log.error(error, 'Error connecting to ufds');
            return callback(error);
        }
        return callback();
    });
};


CNAPI.prototype.initializeHeartbeater = function (options, callback) {
    var self = this;

    self.heartbeater = new Heartbeater(options);
    self.heartbeater.on('heartbeat', self.onHeartbeat.bind(self));
    callback();
    return;
};


CNAPI.prototype.initializeUr = function (options, callback) {
    var self = this;
    self.ur = new Ur(options);
    self.ur.on('serverStartup', self.onServerStartup.bind(self));
    callback();
    return;
};


CNAPI.prototype.collectGlobalSysinfo = function () {
    var self = this;
    self.ur.broadcastSysinfo(function (error, sysinfoCollection) {
        async.forEachSeries(
            sysinfoCollection,
            function (sysinfo, cb) {
                self.refreshServerFromSysinfo(sysinfo, cb);
            },
            function (err) {
                if (err) {
                self.log.error(
                    'Error updating server record from global broadcast: %s',
                    err.message);
                }
            });
    });
};

CNAPI.prototype.initializeServer = function (options, callback) {
    this.log.info('Initializing HTTP server');
    this.server = createServer(options);
    return callback();
};


/**
 * Given a sysinfo object, this function will check if the server exists in
 * UFDS. Because the sysinfo message is sent only on start-up, if the server
 * does exist in UFDS, we will update the record with the most recent
 * information.
 * If the server does not exist, it will be created in UFDS. In either case,
 * the Redis server cache will be updated to reflect that we currently know
 * about this server.
 */
CNAPI.prototype.refreshServerFromSysinfo =
function (sysinfo, callback) {
    var self = this;

    var uuid = sysinfo['UUID'];
    var lastBoot
      = new Date(Number(sysinfo['Boot Time']) * 1000).toISOString();

    var serverModel = new ModelServer(uuid);

    serverModel.getFinal(function (getError, server) {
        if (getError) {
            self.log.error(
                getError, 'Error fetching server %s from ufds', uuid);
            callback(getError);
            return;
        }

        if (server) {
            var ufdsServer = serverModel.valuesFromSysinfo({
                sysinfo: sysinfo,
                last_boot: lastBoot
            });

            var changes = [
                {
                    type: 'replace',
                    modification: ufdsServer
                }
            ];

            serverModel.cacheSetServer(server, function (updateError) {
                if (updateError) {
                    self.log.error(updateError, 'Error updating server cache');
                    self.log.error(server, 'Object in question');
                    callback(updateError);
                    return;
                }
                serverModel.modify(
                    changes,
                    function (modifyError) {
                        if (modifyError) {
                            self.log.error(
                                modifyError,
                                'Error setting last_boot attribute on %s',
                                uuid);
                            self.log.error(
                                util.inspect(changes));
                            return;
                        }
                        self.log.info('Modified Server UFDS record');
                        callback();
                        return;
                    });
            });
        } else {
            serverModel.create(
                { sysinfo: sysinfo, last_boot: lastBoot },
                function (error, s) {
                    if (error) {
                        self.log.error(error, 'Error creating server in ufds');
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
        }
    });
};


/**
 * Take a UUID and a heartbeat object. If the server exists in the cache,
 * update the memory usage cache and the server VMs cache. If the server
 * doesn't exist in the cache, check if it exists in UFDS. If it does exist in
 * UFDS, add the server to the servers cache and the VMs to the server VMs
 * cache. If the server does not exist in UFDS, then create the server in UFDS
 * and then add the appropriate values into UFDS.
 */
CNAPI.prototype.refreshServerFromHeartbeat =
function (uuid, heartbeat, cb) {
    var self = this;

    var serverModel = new ModelServer(uuid);

    serverModel.cacheCheckServerExists(function (error, exists) {
        if (error) {
            self.log.error(error, 'Error checking for server in redis cache');
        }
        if (exists) {
            self.log.trace('Server %s found in local "cache"', uuid);

            updateVmsCacheFromHeartbeat(function (cacheError) {
                if (cacheError) {
                    self.log.error('Could not update VMs cache on heartbeat');
                    return;
                }
                serverModel.cacheSetServerStatus(
                    'running',
                    function (statusError) {
                        if (statusError) {
                            self.log.error(
                                statusError,
                                'Error setting server (%s) status', self.uuid);
                        }
                        serverModel.updateMemoryFromHeartbeat(
                            heartbeat, callback);
                    });
            });
            return;
        }

        self.log.info('Server %s not found in cache, checking in ufds', uuid);

        serverModel.get(function (listError, server) {
            if (listError) {
                self.log.error(listError, 'Error listing servers in ufds');
                callback(listError);
                return;
            }

            updateVmsCacheFromHeartbeat(function (cacheError) {
                if (cacheError) {
                    self.log.error('Could not update VMs cache on heartbeat');
                }

                // Check if there were matching servers in UFDS
                if (server) {
                    serverModel.cacheSetServerStatus(
                        'running',
                        function (statusError) {
                            if (statusError) {
                                self.log.error(
                                    error,
                                    'Error setting server (%s) status',
                                    self.uuid);
                            }
                            serverModel.updateMemoryFromHeartbeat(
                                heartbeat, callback);
                        });
                } else {
                    serverModel.create(
                        { uuid: uuid, heartbeat: heartbeat },
                        function () {
                            serverModel.updateMemoryFromHeartbeat(
                                heartbeat, callback);
                        });
                    return;
                }
            });
        });
    });

    function updateVmsCacheFromHeartbeat(cacheCb) {
        var vms = {};
        heartbeat.zoneStatus.forEach(function (vm) {
            vms[vm[1]] = '1';
        });

        serverModel.cacheSetVms(vms, function (cacheError) {
            if (cacheError) {
                self.log.error('Could not update VMs cache on heartbeat');
                cacheCb(cacheError);
                return;
            }

            cacheCb();
        });
    }

    function callback(error) {
        if (cb) {
            cb(error);
            return;
        }
    }
};


/**
 * Execute this function whenver a sysinfo message is received via AMQP from
 * the Ur agent of a server which has started up.
 */
CNAPI.prototype.onServerStartup = function (message, routingKey) {
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
 * Execute this function whenever a heartbeat is received from a server.
 */
CNAPI.prototype.onHeartbeat = function (heartbeat, routingKey) {
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
                    'Error refreshing server\'s record in ufds');
                return;
            }
        });
};

module.exports = CNAPI;
