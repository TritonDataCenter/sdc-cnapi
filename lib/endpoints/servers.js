var async = require('async');
var uuid = require('node-uuid');
var restify = require('restify');

function Server() {}

Server.list = function (req, res, next) {
    var self = this;
    var result;

    async.waterfall([
        function (wf$callback) {
            var options = {};
            if (req.params.uuids) {
                options.uuid = uuids.split(/\s*,\s*/g);
            }

            self.model.listServers(
                options,
                function (error, s) {
                    if (error) {
                        wf$callback(error);
                        return;
                    }
                    result = s;
                    wf$callback();
                    return;
                });
        }
    ],
    function (error) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }

        res.send(result);
        next();
        return;
    });
};

Server.get = function (req, res, next) {
    var self = this;
    var servers = [];

    async.waterfall([
        function (wf$callback) {
            self.model.listServers(
                { uuid: req.params.server_uuid },
                function (error, s) {
                    if (error) {
                        wf$callback(error);
                        return;
                    }

                    servers = s;
                    wf$callback();
                    return;
                });
        }
    ],
    function (error) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }

        res.send(servers);
        next();
        return;
    });
};

Server.setup = function (req, res, next) {
    var self = this;
    var serverUuid = req.params.uuid;

    self.model.listServers(
        { uuid: serverUuid },
        function (error, servers) {
            // Check if any servers were returned
            if (servers.length === 0) {
                var errorMsg
                    = 'Server ' + req.params.server_uuid + ' not found';
                next(
                    new restify.ResourceNotFoundError(errorMsg));
                return;
            }

            var server = servers[0];

            if (server.setup) {
                res.send(204);
                next();
                return;
            }

            self.model.serverSetup(
                req.params.server_uuid, function (setupError) {
                    if (setupError) {
                        next(
                            new restify.InternalError(
                                setupError.message));
                        return;
                    }
                    res.send(204);
                    next();
                    return;
                });
            });
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // List servers
    http.get(
        { path: '/servers', name: 'ListServers' },
        Server.list.bind(toModel));

    // Get server
    http.get(
        { path: '/servers/:server_uuid', name: 'GetServer' },
        Server.get.bind(toModel));

    // Setup server
    http.put(
        { path: '/servers/:server_uuid/setup', name: 'SetupServer' },
        Server.setup.bind(toModel));

    // Pseudo-W3C (not quite) logging.
    http.on('after', function (req, res, name) {
        model.log.info('[%s] %s "%s %s" (%s)', new Date(), res.statusCode,
        req.method, req.url, name);
    });
}

exports.attachTo = attachTo;
