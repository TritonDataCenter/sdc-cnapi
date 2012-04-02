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
                { serverid: req.params.serverid },
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

function getVm(req, res, next) {
    var self = this;
    self.model.getVm(
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
        { path: '/servers/:server_uuid/vms/:uuid', name: 'GetVm' },
        getVm.bind(server));

    http.post(
        { path: '/servers/:server_uuid', name: 'CreateServer' },
        function (req, res, next) {
//             var newUuid = uuid();
//             var newServer = {'uuid': newUuid};
//             servers[newUuid] = newServer;
            res.send({});
            return next();
        });

    // Pseudo-W3C (not quite) logging.
    http.on('after', function (req, res, name) {
        console.log('[%s] %s "%s %s" (%s)', new Date(), res.statusCode,
        req.method, req.url, name);
    });
}

exports.attachTo = attachTo;
