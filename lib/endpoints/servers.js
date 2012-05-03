var async = require('async');
var uuid = require('node-uuid');
var restify = require('restify');

function Server() {}

Server.list = function (req, res, next) {
    var self = this;
    var servers = [];

    async.waterfall([
        function (wf$callback) {
            self.model.listServers(
                req.params,
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

    // Pseudo-W3C (not quite) logging.
    http.on('after', function (req, res, name) {
        model.log.info('[%s] %s "%s %s" (%s)', new Date(), res.statusCode,
        req.method, req.url, name);
    });
}

exports.attachTo = attachTo;
