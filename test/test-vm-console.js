/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */

/*
 * Unit tests for the VmConsole endpoint handler.
 */

var bunyan = require('bunyan');
var restifyValidator = require('restify-validator');
var VError = require('verror');

var vms = require('../lib/endpoints/vms');

var TOKEN = new Array(65).join('a');
var VM_UUID = '7a1e0b16-6a2d-4f8e-8f4c-1c9a54e0e702';

var log = bunyan.createLogger({name: 'test-vm-console', level: 'fatal'});

function getConsoleHandler() {
    var routes = {};
    var fakeHttp = {};

    ['get', 'post', 'put', 'del', 'head'].forEach(function (m) {
        fakeHttp[m] = function (opts) {
            var chain = Array.prototype.slice.call(arguments, 1);
            routes[opts.name] = {method: m, path: opts.path, chain: chain};
        };
    });
    vms.attachTo(fakeHttp, {
        getLog: function () {
            return (log);
        }
    });
    return (routes.VmConsole);
}

function callHandler(infoErr, infoResponse, cb) {
    var route = getConsoleHandler();
    var handler = route.chain[route.chain.length - 1];
    var sent;
    var req = {
        params: {uuid: VM_UUID, server_uuid: VM_UUID},
        log: log,
        getId: function () {
            return ('req-id');
        },
        stash: {
            vm: {
                info: function (opts, infoCb) {
                    req.infoOpts = opts;
                    infoCb(infoErr, infoResponse);
                }
            }
        }
    };
    var res = {
        send: function (code, body) {
            sent = (body === undefined) ? code : body;
        }
    };

    restifyValidator(req, res, function () {
        handler(req, res, function (err) {
            cb(err, sent, req);
        });
    });
}

function ticket(overrides) {
    var t = {
        host: '10.99.99.7',
        port: 40123,
        token: TOKEN,
        type: 'zone',
        expires_in: 30
    };
    Object.keys(overrides || {}).forEach(function (k) {
        t[k] = overrides[k];
    });
    return (JSON.stringify({console: t}));
}

exports.test_route_is_post = function (t) {
    var route = getConsoleHandler();

    t.equal(route.method, 'post');
    t.equal(route.path, '/servers/:server_uuid/vms/:uuid/console');
    t.done();
};

exports.test_valid_ticket = function (t) {
    callHandler(null, ticket(), function (err, body, req) {
        t.ifError(err);
        t.deepEqual(req.infoOpts.types, ['console']);
        t.deepEqual(body, {
            host: '10.99.99.7',
            port: 40123,
            token: TOKEN,
            type: 'zone',
            expires_in: 30
        });
        t.done();
    });
};

exports.test_invalid_tickets = function (t) {
    var bad = [
        {token: 'short'},
        {token: TOKEN.toUpperCase()},
        {port: 0},
        {port: '40123'},
        {host: ''},
        {type: 'socket'},
        {expires_in: undefined}
    ];
    var n = 0;

    bad.forEach(function (b) {
        callHandler(null, ticket(b), function (err, body) {
            t.ok(err, 'rejected ' + JSON.stringify(b));
            t.equal(err.statusCode, 500);
            t.equal(body, undefined);
            if (++n === bad.length) {
                t.done();
            }
        });
    });
};

exports.test_missing_console = function (t) {
    callHandler(null, '{}', function (err) {
        t.equal(err.statusCode, 500);
        t.done();
    });
};

exports.test_unparseable_response = function (t) {
    callHandler(null, 'not json', function (err) {
        t.equal(err.statusCode, 500);
        t.done();
    });
};

exports.test_vm_not_running = function (t) {
    var cause = new Error('vmadm.info error: Unable to get info for vm ' +
        'from state "stopped", must be "running" or "stopping".');

    cause.body = {};
    callHandler(new VError(cause, 'posting task to cn-agent'), null,
        function (err) {
            t.equal(err.statusCode, 409);
            t.done();
        });
};

exports.test_vm_not_found = function (t) {
    var cause = new Error('no such vm');

    cause.body = {details: {restCode: 'VmNotFound'}};
    callHandler(new VError(cause, 'posting task to cn-agent'), null,
        function (err) {
            t.equal(err.statusCode, 404);
            t.done();
        });
};
