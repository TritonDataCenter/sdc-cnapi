var async = require('async');

var createUfdsModel = require('./models').createUfdsModel;
var createServer = require('./server').createServer;
var Heartbeater = require('./heartbeater');
var Ur = require('./ur');

function CNAPI() {

}

CNAPI.prototype.start = function () {
    var server;
    var model;
    var heartbeaterListener;
    var urListener;

    var modelOptions = {
        ufdsSettings: {
            host: 'ufds_host',
            port: 12345,
            user: 'ufds_user',
            user: 'ufds_pass'
        }
    };

    var heartbeaterOptions = {
        host: '10.99.99.5'
    };

    var urOptions = {
        host: '10.99.99.5'
    };

    async.waterfall([
        function (wf$callback) {
            model = createUfdsModel(modelOptions);
            // model.onError(...);
            model.connect(function () {
                return wf$callback();
            });
        },
        function (wf$callback) {
            var serverOptions = {
                model: model
            };
            server = createServer(serverOptions);
            return wf$callback();
        },
        function (wf$callback) {
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
            urListener = new Ur(urOptions);
            urListener.on('serverStartup', function (message, routingKey) {
                console.log('Saw a server come online');
                console.dir(arguments);
            });

            urListener.on('connectionError', function (err) {
                console.log('Ur AMQP connection error');
                console.dir(arguments);
            });
        }
    ],
    function (error) {
        server.listen(8080, function () {
          console.log('%s listening at %s', server.name, server.url);
        });
    });
};

module.exports = CNAPI;
