var async = require('async');
var uuid = require('node-uuid');
var restify = require('restify');

function Server(model) {
    this.model = model;
}

function listServers(req, res, next) {
    var self = this;
    var servers = [];

    async.waterfall([
        function (wf$callback) {
            self.model.listServers(
                {},
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
    var servers = [];

    async.waterfall([
        function (wf$callback) {
            self.model.listServers(
                { uuid: req.params.uuid },
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

function loadVm(req, res, next) {
    var self = this;
    self.model.loadVm(
        req.params.server_uuid,
        req.params.uuid,
        function (error, vm) {
            res.send(vm);
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

    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'LoadVm' },
        loadVm.bind(server));

    http.post(
        { path: '/servers/:server_uuid', name: 'CreateServer' },
        function (req, res, next) {
            res.send({});
            return next();
        });

    // Pseudo-W3C (not quite) logging.
    http.on('after', function (req, res, name) {
        model.log.info('[%s] %s "%s %s" (%s)', new Date(), res.statusCode,
        req.method, req.url, name);
    });
}

exports.attachTo = attachTo;
