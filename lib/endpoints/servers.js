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

    self.model.listServers(
        { uuid: req.params.server_uuid },
        function (error, server) {
            if (error) {
                next(new restify.InternalError(error.message));
                return;
            }

            if (!server) {
                var errorMsg
                    = 'Server ' + req.params.server_uuid + ' not found';
                next(
                    new restify.ResourceNotFoundError(errorMsg));
                return;
            }

            res.send(server);
            next();
            return;
        });
};

Server.update = function (req, res, next) {
    var self = this;

    var attrs = [
        'default_console',
        'reserved',
        'serial',
        'serial_speed',
        'setup'
    ];

    var changes = [];

    attrs.forEach(function (k) {
        if (typeof (req.params[k]) === 'undefined') {
            return;
        }

        var change = { type: 'replace', modification: {} };
        change.modification[k] = req.params[k];
        changes.push(change);
    });

    self.model.modifyServer(
        req.params.server_uuid,
        changes,
        function (error) {
            if (error) {
                next(new restify.InternalError(error.message));
                return;
            }

            res.send(204);
            next();
            return;
        });
};

Server.setup = function (req, res, next) {
    var self = this;
    var serverUuid = req.params.server_uuid;

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
                res.send(204, server);
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

    // Update server
    http.post(
        { path: '/servers/:server_uuid', name: 'UpdateServer' },
        Server.update.bind(toModel));

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
