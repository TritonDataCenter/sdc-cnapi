var async = require('async');

var createUfdsModel = require('./models').createUfdsModel;
var createServer = require('./server').createServer;
var Heartbeater = require('./heartbeater');
var Ur = require('./ur');

function CNAPI(config) {
    this.config = config;
}

CNAPI.prototype.start = function () {
    var self = this;
    var server;
    var model;
    var heartbeaterListener;
    var urListener;

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
            model = createUfdsModel(modelOptions);
            // model.onError(...);
            model.connect(function () {
                console.info('Model connected');
                return wf$callback();
            });
        },
        function (wf$callback) {
            // Initialize the HTTP server

            var serverOptions = {
                model: model
            };
            server = createServer(serverOptions);
            return wf$callback();
        },
        function (wf$callback) {
            // Initialize our Heartbeater client

            heartbeaterListener = new Heartbeater(heartbeaterOptions);
            heartbeaterListener.on('heartbeat',
                function (heartbeat, routingKey) {
                    var serverUuid = routingKey.split('.')[1];
                    console.log('Heartbeat (%s) received -- %d zones.',
                        serverUuid, heartbeat[0].length);
                });
            heartbeaterListener.on('connectionError', function (err) {
                console.dir(arguments);
            });

            return wf$callback();
        },
        function (wf$callback) {
            // Initialize our Ur listener

            urListener = new Ur(urOptions);
            urListener.on('serverStartup', function (message, routingKey) {
                console.log('Saw a server come online');
                console.dir(arguments);
            });

            urListener.on('connectionError', function (err) {
                console.log('Ur AMQP connection error');
                console.dir(arguments);
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

module.exports = CNAPI;
