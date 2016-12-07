/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var os = require('os');
var restify = require('restify');
var restifyValidator = require('restify-validator');
var jsprim = require('jsprim');
var tritonTracer = require('triton-tracer');

var endpoints = require('./endpoints/index');
var request_seq_id = 0;


function createServer(options) {
    var cnapi;
    var cnapiVersion = require(__dirname + '/../package.json').version;

    cnapi = restify.createServer({
        name: 'cnapi/' + cnapiVersion,
        log: options.log,
        handleUpgrades: true,
        handleUncaughtExceptions: false
    });

    cnapi.use(restify.requestLogger());

    // Start the tracing backend and instrument this restify 'server'.
    tritonTracer.instrumentRestifyServer({
        server: cnapi
    });

    cnapi.use(restify.acceptParser(cnapi.acceptable));
    cnapi.use(restify.queryParser({
        mapParams: true,
        allowDots: false,
        plainObjects: false
    }));
    cnapi.use(restify.bodyParser());
    cnapi.use(restifyValidator);


    // Add a default timeout of one hour
    cnapi.use(function setDefaultTimeouts(req, res, next) {
        req.connection.setTimeout(3600 * 1000);
        res.connection.setTimeout(3600 * 1000);
        next();
    });

    var AUDIT_SKIP_ROUTES = {
        'ping': true,
        'servereventheartbeat': true,
        'servereventvmsupdate': true
    };

    var AUDIT_OMIT_BODY_ROUTES = {
        'vmdockerbuild': true
    };

    cnapi.on('after', function _onAfter(req, res, route, err) {
        var HTTP_STATUS_DIVISOR = 100;
        var HTTP_STATUS_CLASS_SUCCESS = 2;
        var HTTP_CODE_MISSING = 404;

        var isOmitBodyRoute = req.route &&
            jsprim.hasKey(AUDIT_OMIT_BODY_ROUTES, req.route.name) &&
            AUDIT_OMIT_BODY_ROUTES[req.route.name];

        // Successful GET res bodies are uninteresting and *big*.
        var includeBody = !isOmitBodyRoute && req.method !== 'GET' &&
            res.statusCode !== HTTP_CODE_MISSING &&
            Math.floor(res.statusCode / HTTP_STATUS_DIVISOR)
                !== HTTP_STATUS_CLASS_SUCCESS;

        if (req.route && AUDIT_SKIP_ROUTES[req.route.name]) {
            return;
        }

        restify.auditLogger({
            log: req.log.child({ route: route && route.name }, true),
            body: includeBody
        })(req, res, route, err);
    });

    cnapi.use(function setHeaders(req, res, next) {
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
