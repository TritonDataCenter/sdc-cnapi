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
                /*JSSTYLED*/
                options.uuid = req.params.uuids.split(/\s*,\s*/g);
            }

            if (req.params.setup) {
                options.setup = req.params.setup;
            }

            self.model.log.info(options, 'Searching for all servers');
            self.model.listServers(
                options,
                function (error, s) {
                    if (error) {
                        wf$callback(error);
                        return;
                    }
                    self.model.log.info(s, 'Servers found');
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
    var server;

    async.waterfall([
        function (wf$callback) {
            self.model.listServers(
                { uuid: req.params.server_uuid },
                function (error, s) {
                    if (error) {
                        wf$callback(error);
                        return;
                    }

                    server = s;
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

        res.send(server);
        next();
        return;
    });
};

Server.setup = function (req, res, next) {
    var self = this;
    var serverUuid = req.params.uuid;

    self.model.listServers(
        { uuid: serverUuid },
        function (error, server) {
            // Check if any servers were returned
            if (!server) {
                var errorMsg
                    = 'Server ' + req.params.server_uuid + ' not found';
                next(
                    new restify.ResourceNotFoundError(errorMsg));
                return;
            }

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
