var async = require('async');
var uuid = require('node-uuid');

function Server(model) {
    this.model = model;
}

function listServers(req, res, next) {
    var self = this;
    var servers = [];

    async.waterfall([
        function (wf$callback) {
            self.model.getServers(
                function (error, s) {
                    if (error) {
                        return wf$callback(error);
                    }

                    servers = s;
                    return wf$callback();
                });
        }
    ],
    function (error) {
        if (error) {
            return next(
                new restify.InternalError(error.message));
        }

        res.send(servers);
        return next();
    });
}

function getServer(req, res, next) {
    var self = this;
    var server_uuid = req.params.server_uuid;
    var server;

    async.waterfall([
        function (wf$callback) {
            self.model.getServer(
                server_uuid,
                function (error, s) {
                    if (error) {
                        return wf$callback(error);
                    }

                    server = s;
                    return wf$callback();
                });
        }
    ],
    function (error) {
        if (error) {
            return next(
                new restify.InternalError(error.message));
        }

        if (!server) {
            return next(
                new restify.ResourceNotFoundError('No such server.'));
        }
        res.send(server);
        return next();
    });
}

function attachTo(http, model) {
    var server = new Server(model);

    http.get(
        { path: '/servers', name: 'ListServers' },
        listServers.bind(server));

    http.get(
        { path: '/servers/:server_uuid', name: 'GetServer' },
        getServer.bind(server));

    http.post(
        { path: '/servers/:server_uuid', name: 'CreateServer' },
        function (req, res, next) {
            var newUuid = uuid();
            var newServer = {'uuid': newUuid};
            servers[newUuid] = newServer;
            res.send(newServer);
            return next();
        });

    // Pseudo-W3C (not quite) logging.
    http.on('after', function (req, res, name) {
        console.log('[%s] %s "%s %s" (%s)', new Date(), res.statusCode,
        req.method, req.url, name);
    });
}

exports.attachTo = attachTo;
