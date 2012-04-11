var async = require('async');
var Logger = require('bunyan');
var restify = require('restify');
var http = require('http');
var https = require('https');

var createUfdsModel = require('./models').createUfdsModel;
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
            res: restify.bunyan.serializers.response
        }
    });
}

CNAPI.prototype.start = function () {
    var self = this;

    http.globalAgent.maxSockets = self.config.maxHttpSockets || 100;
    https.globalAgent.maxSockets = self.config.maxHttpSockets || 100;

    var modelOptions = {
        ufds: self.config.ufds,
        amqp_use_system_config: false,
        amqp: self.config.amqp,
        log: self.log
    };

    var heartbeaterOptions = {
        host: '10.99.99.5',
        log: self.log
    };

    var urOptions = {
        host: '10.99.99.5',
        log: self.log
    };


    async.waterfall([
        function (callback) {
            self.initializeModel(modelOptions, callback);
        },
        function (callback) {
            var serverOptions = {
                model: self.model
            };
            self.initializeServer(serverOptions, callback);
        },
        function (callback) {
            self.initializeHeartbeater(heartbeaterOptions, callback);
        },
        function (callback) {
            self.initializeUr(urOptions, callback);
        }
    ],
    function (error) {
        self.server.listen(8080, function () {
            self.log.info(
                '%s listening at %s',
                self.server.name,
                self.server.url);
        });
    });
};

CNAPI.prototype.initializeModel = function (options, callback) {
    var self = this;

    self.log.info('Initializing model and connecting to ufds');

    var model = self.model = createUfdsModel(options);
    model.connect(function (error) {
        if (error) {
            self.log.error(error, 'Error connecting to ufds');
            return callback(error);
        }
        self.log.debug('Model connected');
        return callback();
    });
};

CNAPI.prototype.initializeServer = function (options, callback) {
    this.server = createServer(options);
    return callback();
};

CNAPI.prototype.initializeHeartbeater = function (options, callback) {
    var self = this;

    var heartbeaterListener = new Heartbeater(options);
    heartbeaterListener.on('heartbeat', self.onHeartbeat.bind(self));
    heartbeaterListener.on('connectionError', function (err) {
        self.log.info('Connection error ' + err.message);
    });

    return callback();
};

CNAPI.prototype.initializeUr = function (options, callback) {
    var self = this;
    var ur = self.ur = new Ur(options);

    ur.connect(function () {
        ur.on('serverStartup', self.onServerStartup.bind(self));

        ur.on('connectionError', function (err) {
            self.log.info('Ur AMQP connection error');
        });
    });

    return callback();
};

CNAPI.prototype.refreshServerFromSysinfo = function (uuid, sysinfo, callback) {
    var self = this;

    if (self.servers[uuid]) {
        self.log.debug('Server %s found in local "cache"', uuid);
        return;
    }

    self.log.info('Server %s not found in cache, checking in ufds', uuid);

    self.model.listServers({ uuid: uuid }, function (list$error, servers) {
        if (list$error) {
            self.log.error(list$error, 'Error listing servers in ufds');
            return callback(list$error);
        }

        if (servers.length > 0) {
            self.log.info('%s already in ufds', uuid);
            self.servers[uuid] = servers[0];
            return callback(null, servers[0]);
        }

        return (
            self.model.createServerFromSysinfo(
                sysinfo,
                function (error, server) {
                    if (error) {
                        self.log.info(error, 'Error creating server in ufds');
                        return;
                    }
                    self.log.debug('Cached server in memory');
                    self.servers[uuid] = server;
                }));
    });
};

CNAPI.prototype.refreshServer = function (uuid, callback) {
    var self = this;

    if (self.servers[uuid]) {
        self.log.debug('Server %s found in local "cache"', uuid);
        callback(null, self.servers[uuid]);
        return;
    }

    self.log.info('Server %s not found in cache, checking in ufds', uuid);

    self.model.listServers({ uuid: uuid }, function (list$error, servers) {
        if (list$error) {
            self.log.error(list$error, 'Error listing servers in ufds');
            callback(list$error);
            return;
        }
        if (servers.length > 0) {
            self.log.info('%s already in ufds', uuid);
            self.servers[uuid] = servers[0];
            if (callback) {
                callback(null, servers[0]);
                return;
            }
        }

        self.ur.serverSysinfo(uuid, function (error, sysinfo) {
            self.model.createServerFromSysinfo(
                sysinfo,
                function (create$error, server) {
                    if (create$error) {
                        self.log.info('Error creating server in ufds');
                        callback(create$error);
                        return;
                    }

                    if (callback) {
                        callback(null, server);
                        return;
                    }
                });
        });
    });
};

CNAPI.prototype.onServerStartup = function (message, routingKey) {
    var self = this;

    var uuid = routingKey.split('.')[2];
    self.log.info('Ur startup message received from %s', uuid);
    self.log.trace(message);

    self.refreshServerFromSysinfo(uuid, message);
};

CNAPI.prototype.onHeartbeat = function (heartbeat, routingKey) {
    var self = this;
    var uuid = routingKey.split('.')[1];
    self.log.debug('Heartbeat (%s) received -- %d zones.',
        uuid, heartbeat[0].length);

    self.refreshServer(uuid, function (error, server) {
        if (error) {
            self.log.error(error, 'Error refreshing server\'s record in ufds');
            return;
        }
        self.servers[uuid] = server;
    });
};

module.exports = CNAPI;
