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

var WFAPI = require('./wfapi');

var createModel = require('./models').createModel;
var createServer = require('./server').createServer;
var sysinfoToLdapServer = require('./models').sysinfoToLdapServer;
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
            res: restify.bunyan.serializers.response
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
        redis: self.config.redis,
        wfapi: self.config.wfapi,
        dapi: self.config.dapi,
        napi: self.config.napi,
        cnapi: self.config.cnapi,
        assets: self.config.assets,
        vmapi: self.config.vmapi,
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
            var wfapi = new WFAPI(self.config);
            wfapi.initWorkflows();
            self.model.setWfapi(wfapi);
            return (callback());
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
        self.log.debug('Model connected');
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

CNAPI.prototype.refreshServerFromSysinfo =
function (sysinfo, callback) {
    var self = this;

    var uuid = sysinfo['UUID'];
    var lastBoot
      = new Date(Number(sysinfo['Boot Time']) * 1000).toISOString();

    self.model.listServers({ uuid: uuid }, function (listError, server) {
        if (listError) {
            self.log.error(listError, 'Error listing servers in ufds');
            callback(listError);
            return;
        }

        if (server) {
            var changes = [
                {
                    type: 'replace',
                    modification: { last_boot: lastBoot }
                }
            ];

            server.last_boot = lastBoot;

            self.model.serverUpdateCache(uuid, server, function (updateError) {
                if (updateError) {
                    self.log.error(updateError, 'Error updating server cache');
                    callback(updateError);
                    return;
                }
                self.model.modifyServer(
                    uuid,
                    changes,
                    function (modifyError) {
                        if (modifyError) {
                            self.log.error(
                                modifyError,
                                'Error setting last_boot attribute on %s',
                                uuid);
                            return;
                        }
                        callback();
                        return;
                    });
            });
        } else {
            self.createUfdsServerObject(
                { uuid: uuid, sysinfo: sysinfo, last_boot: lastBoot },
                function (error, s) {
                    if (error) {
                        self.log.error(error, 'Error creating server in ufds');
                        return;
                    }
                    self.log.debug('Cached server in memory');
                    self.model.serverCacheUpdate(
                        uuid, s,
                        function (updateError) {
                            if (updateError) {
                                self.log.error(
                                    updateError,
                                    'Error updating server cache');
                                callback(updateError);
                                return;
                            }
                            callback();
                    });
                });
        }
    });
};

CNAPI.prototype.updateServerMemory =
function (uuid, heartbeat, callback) {
    var self = this;

    var memoryKeys = [
        ['availrmem_bytes', 'memory_available_bytes'],
        ['arcsize_bytes', 'memory_arc_bytes'],
        ['total_bytes', 'memory_total_bytes'] ];

    var memory = {};

    memoryKeys.forEach(function (keys) {
        memory[keys[1]] = heartbeat.meminfo[keys[0]].toString();
    });

    self.model.serverUpdateMemoryCache(uuid, memory, callback);
};

CNAPI.prototype.refreshServerFromHeartbeat =
function (uuid, heartbeat, cb) {
    var self = this;

    // if server exists
    self.model.serverCheckExistsCache(uuid, function (error, exists) {
        if (exists) {
            self.log.trace('Server %s found in local "cache"', uuid);

            self.updateServerMemory(
                uuid, heartbeat, callback);
            return;
        }

        self.log.info('Server %s not found in cache, checking in ufds', uuid);

        self.model.listServers({ uuid: uuid }, function (listError, server) {
            if (listError) {
                self.log.error(listError, 'Error listing servers in ufds');
                callback(listError);
                return;
            }

            var vms = {};
            heartbeat.zoneStatus.forEach(function (vm) {
                vms[vm[1]] = '1';
            });

            self.model.serverUpdateVmsCache(uuid, vms, function (cacheError) {
                if (cacheError) {
                    self.log.error('Could not update VMs cache on heartbeat');
                    return;
                }

                // Check if there were matching servers in UFDS
                if (server) {
                    self.updateServerMemory(
                        uuid, heartbeat, callback);
                    return;
                } else {
                    self.createUfdsServerObject(
                        { uuid: uuid, heartbeat: heartbeat },
                        callback);
                    return;
                }
            });
        });
    });


    function callback(error) {
        if (cb) {
            cb(error);
            return;
        }
    }
};

CNAPI.prototype.createUfdsServerObject = function (opts, callback) {
    var self = this;
    var uuid = opts.uuid;
    var serverSysinfo;

    if (opts.sysinfo) {
        serverSysinfo = opts.sysinfo;
        create();
        return;
    } else {
        self.log.info('Querying Ur agent for server sysinfo');
        self.ur.serverSysinfo(uuid, function (error, sysinfo) {
            serverSysinfo = sysinfo;
            create();
            return;
        });
    }

    function create() {
        var heartbeat = opts.heartbeat;
        var server = self.serverObjectFromSysinfo({
            heartbeat: heartbeat,
            sysinfo: serverSysinfo,
            last_boot: opts.last_boot
        });

        server.last_updated = (new Date()).toISOString();
        self.log.debug(server, 'Creating server in UFDS');
        self.model.createServer(
            server,
            function (createError, createdServer) {
                if (createError) {
                    self.log.info('Error creating server in UFDS');
                    callback(createError);
                    return;
                }
                self.log.info('Created server entry in UFDS');
                callback();
                return;
            });
    }
};

CNAPI.prototype.serverObjectFromSysinfo = function (opts) {
    var self = this;

    var server = {};
    var sysinfo = opts.sysinfo;
    var heartbeat = opts.heartbeat;

    server.sysinfo = JSON.stringify(sysinfo);
    server.datacenter = self.config.datacenter_name;

    server.uuid = sysinfo.UUID;
    server.hostname = sysinfo.Hostname;
    server.reserved = 'false';
    server.headnode
        = sysinfo['Boot Parameters']['headnode'] === 'true' ? 'true' : 'false';
    server.setup = sysinfo['Zpool'] ? 'true' : 'false';

    if (opts.last_boot) {
        server.last_boot = opts.last_boot;
    }

    server.status = 'running';
    server.default_console = 'vga';
    server.serial = 'ttyb';
    server.serial_speed = '115200';
    server.objectclass = 'server';

    if (heartbeat) {
        var meminfo = heartbeat.meminfo;
        server.memory = {};
        server.memory.memory_available_bytes
            = meminfo.availrmem_bytes.toString();
        server.memory.memory_arc_bytes = meminfo.arcsize_bytes.toString();
        server.memory.memory_total_bytes = meminfo.total_bytes.toString();
    }

    return server;
};

CNAPI.prototype.onServerStartup = function (message, routingKey) {
    var self = this;

    var uuid = routingKey.split('.')[2];
    self.log.info('Ur startup message received from %s', uuid);
    self.log.trace(message);

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
