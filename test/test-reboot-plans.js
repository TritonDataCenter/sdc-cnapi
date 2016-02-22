/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * test-reboot-plans.js: Tests for reboot-plans endpoint.
 */

var async   = require('async');
var http    = require('http');
var restify = require('restify');


var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var client;
var servers;
var plan;


function setup(callback) {
    client = restify.createJsonClient({
        agent: false,
        url: CNAPI_URL
    });

    client.basicAuth('admin', 'joypass123');

    callback();
}

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function validatePlan(t, p, options) {
    t.ok(p.uuid);
    t.ok(UUID_RE.test(p.uuid));
    t.equal(p.state, 'created');
    if (options.reboots) {
        t.ok(Array.isArray(p.reboots));
        p.reboots.forEach(function (r) {
            t.ok(r.server_uuid);
            t.ok(r.server_hostname);
            if (r.started_at) {
                var s = new Date(r.started_at);
                t.notEqual(s.toString(), 'Invalid Date');
            }
            if (r.finished_at) {
                var f = new Date(r.started_at);
                t.notEqual(f.toString(), 'Invalid Date');
            }
            if (r.job_uuid) {
                t.ok(UUID_RE.test(r.job_uuid));
            }
        });
    }
}

function testGetSetupServers(t) {
    client.get('/servers?setup=true', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            t.ok(server.setup);
            t.ok(server.uuid);
            t.ok(server.hostname);
        });

        servers = body;

        t.done();
    });

}

// As far as you don't set the reboot plan state to "running", the runner
// will not pick it.
function testCreateRebootPlan(t) {
    client.post('/reboot-plans', {
        servers: servers.map(function (s) {
            return (s.uuid);
        }).join(',')
    }, function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);
        t.equal(res.statusCode, 201);
        t.ok(body.uuid);
        plan = body;
        t.done();
    });

}

function testGetRebootPlan(t) {
    client.get('/reboot-plans/' + plan.uuid, function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);
        t.equal(res.statusCode, 200);
        validatePlan(t, body, {reboots: true});
        plan = body;
        t.done();
    });
}

function testListRebootPlans(t) {
    client.get('/reboot-plans', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (p) {
            validatePlan(t, p, {});
        });

        t.done();
    });
}

function testListRebootPlansWithReboots(t) {
    client.get('/reboot-plans?include_reboots=true',
            function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (p) {
            validatePlan(t, p, {reboots: true});
        });

        t.done();
    });
}





var util = require('util');


function testModifyRebootPlan(t) {
    client.put('/reboot-plans/' + plan.uuid, {
        action: 'cancel'
    }, function (err, req, res, body) {
        t.ifError(err);
        t.equal(204, res.statusCode);
        t.done();
    });
}

function testDeleteRebootPlan(t) {
    client.del('/reboot-plans/' + plan.uuid, function (err, req, res, body) {
        t.ifError(err);
        t.equal(204, res.statusCode);
        t.done();
    });
}


module.exports = {
    setUp: setup,
    'list setup servers': testGetSetupServers,
    'create reboot-plan': testCreateRebootPlan,
    'get reboot plan': testGetRebootPlan,
    'list reboot-plans': testListRebootPlans,
    'list reboot-plans with reboots': testListRebootPlansWithReboots,
    'modify reboot-plan': testModifyRebootPlan,
    'delete reboot-plan': testDeleteRebootPlan
};
