/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var os = require('os');
var restify = require('restify');
var restifyValidator = require('restify-validator');
var Tracer = require('triton-tracer');

var endpoints = require('./endpoints/index');
var request_seq_id = 0;


function getClient(clientName, req) {
    assert.object(req, 'req');
    assert.object(req.app, 'req.app');
    assert.object(req.app[clientName], 'req.app[' + clientName + ']');

    // shortcut for non-restify clients which we don't yet wrap
    if (clientName === 'ufds') {
        return (req.app.ufds);
    } else if (clientName === 'moray') {
        return (req.app.moray);
    }

    // We only want to create one child client for each type of client per
    // request (since the trace data will be the same) so if we already created
    // a child, we'll return that.
    if (!req.clientChildren) {
        req.clientChildren = {};
    }

    if (!req.clientChildren[clientName]) {
        req.log.debug('creating child for ' + clientName);
        req.clientChildren[clientName] = req.app[clientName].child(req);
    }

    return (req.clientChildren[clientName]);
}

function createServer(options) {
    var cnapi = restify.createServer({
        name: 'Compute Node API',
        log: options.log,
        handleUpgrades: true
    });

    // Start the tracing backend and instrument this restify 'server'.
    Tracer.restifyServer.init({log: options.log, restifyServer: cnapi});

    cnapi.use(restify.requestLogger());

    cnapi.use(function (req, res, next) {
        // this will return a client if called as req.getClient('fwapi')
        req.getClient = function _getClient(clientName) {
            return getClient(clientName, req);
        };
        next();
    });

    // TODO: use this to skip routes from tracing
    var EVT_SKIP_ROUTES = {
        'ping': true,
        'servereventheartbeat': true,
        'servereventvmsupdate': true
    };

    cnapi.use(restify.acceptParser(cnapi.acceptable));
    cnapi.use(restify.authorizationParser());
    cnapi.use(restify.queryParser());
    cnapi.use(restify.bodyParser());
    cnapi.use(restifyValidator);


    // Add a default timeout of one hour
    cnapi.use(function (req, res, next) {
        req.connection.setTimeout(3600 * 1000);
        res.connection.setTimeout(3600 * 1000);
        next();
    });

    var AUDIT_SKIP_ROUTES = {
        'ping': true,
        'servereventheartbeat': true,
        'servereventvmsupdate': true
    };
    cnapi.on('after', function (req, res, route, err) {
        if (req.route && AUDIT_SKIP_ROUTES[req.route.name]) {
            return;
        }

        // Successful GET res bodies are uninteresting and *big*.
        var body = req.method !== 'GET' &&
                   res.statusCode !== 404 &&
                   Math.floor(res.statusCode/100) !== 2;
        restify.auditLogger({
            log: req.log.child({ route: route && route.name }, true),
            body: body
        })(req, res, route, err);
    });

    cnapi.use(function (req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', cnapi.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });
        next();
    });

    cnapi.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });

    endpoints.attachTo(cnapi, options.app);

    return cnapi;
}

exports.createServer = createServer;
