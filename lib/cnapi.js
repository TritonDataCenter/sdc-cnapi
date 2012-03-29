var async = require('async');

var createUfdsModel = require('./models').createUfdsModel;
var createServer = require('./server').createServer;
var Heartbeater = require('./heartbeater');
var Ur = require('./ur');

function CNAPI(config) {
    this.config = config;
    this.servers = {};
}

CNAPI.prototype.start = function () {
    var self = this;
    var server;
    var model;
    var heartbeaterListener;
    var ur;

    var modelOptions = {
        ufds: self.config.ufds
    };

    var heartbeaterOptions = {
        host: '10.99.99.5'
    };

    var urOptions = {
        host: '10.99.99.5'
    };

    async.waterfall([
        function (wf$callback) {
            console.info('Model connecting to ufds');
            // Initialize the model
            var model = self.model = createUfdsModel(modelOptions);
            // model.onError(...);
            model.connect(function () {
                console.info('Model connected');
                return wf$callback();
            });
        },
        function (wf$callback) {
            // Initialize the HTTP server

            var serverOptions = {
                model: self.model
            };
            server = createServer(serverOptions);
            return wf$callback();
        },
        function (wf$callback) {
            // Initialize our Heartbeater client

            heartbeaterListener = new Heartbeater(heartbeaterOptions);
            heartbeaterListener.on('heartbeat', self.onHeartbeat.bind(self));
            heartbeaterListener.on('connectionError', function (err) {
            });

            return wf$callback();
        },
        function (wf$callback) {
            // Initialize our Ur listener

            var ur = self.ur = new Ur(urOptions);

            ur.connect(function () {
                ur.on('serverStartup', function (message, routingKey) {
                    console.log('Saw a server come online');
                    console.dir(arguments);
                });

                ur.on('connectionError', function (err) {
                    console.log('Ur AMQP connection error');
                    console.dir(arguments);
                });
            });

            return wf$callback();
        }
    ],
    function (error) {
        server.listen(8080, function () {
          console.log('%s listening at %s', server.name, server.url);
        });
    });
};

CNAPI.prototype.onHeartbeat = function (heartbeat, routingKey) {
    var self = this;
    /* - Receive heartbeat
     * - Check server "cache" to see if we know about this machine
     * - If not in cache, list for that uuid in ufds
     * - if not in UFDS, add a new ufds entry for server
     */
    var uuid = routingKey.split('.')[1];
    console.log('Heartbeat (%s) received -- %d zones.',
        uuid, heartbeat[0].length);

    if (self.servers[uuid]) {
        return;
    }
    console.log("Server %s not found in cache, adding to UFDS", uuid);

    self.model.listServers({ uuid: uuid }, function (error, servers) {
        if (servers.length > 0) {
            console.log("%s already in ufds", uuid);
            self.servers[uuid] = servers[0];
            return;
        }
    
        self.ur.serverSysinfo(uuid, function (error, sysinfo) {
            self.model.createServerFromSysinfo(sysinfo, function (error, server) {
                if (error) {
                    console.error("Error creating server in UFDS");
                    return;
                }
                self.servers[uuid] = server;
                console.log("Added server %s to ufds", uuid);
            });
        });
    });
}

module.exports = CNAPI;
