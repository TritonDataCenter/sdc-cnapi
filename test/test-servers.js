/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * test-servers.js: Tests for servers endpoint.
 */

var http    = require('http');
var restify = require('restify');


var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var client;


function setup(callback) {
    client = restify.createJsonClient({
        agent: false,
        url: CNAPI_URL
    });

    client.basicAuth('admin', 'joypass123');

    callback();
}


// this test assumes all CNs known by CNAPI are setup
function testListServersWithCapacity(t) {
    client.get('/servers?extras=capacity', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            t.ok(typeof (server.unreserved_cpu)  === 'number');
            t.ok(typeof (server.unreserved_ram)  === 'number');
            t.ok(typeof (server.unreserved_disk) === 'number');

            t.ifError(server.sysinfo);
            t.ifError(server.vms);
        });

        t.done();
    });
}


// this test assumes all CNs known by CNAPI are setup
function testListServersWithAll(t) {
    client.get('/servers?extras=all', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            t.ok(typeof (server.unreserved_cpu)  === 'number');
            t.ok(typeof (server.unreserved_ram)  === 'number');
            t.ok(typeof (server.unreserved_disk) === 'number');

            t.ok(server.sysinfo);
            t.ok(server.vms);
        });

        t.done();
    });
}


// Entries that allocator depends on aren't populated by CNAPI for 10-15 seconds
// after CNAPI starts. During that interval, this test will fail.
function testGetServer(t) {
    client.get('/servers?headnode=true', function (err, req, res, body) {
        t.ifError(err);
        var uuid = body[0].uuid;

        client.get('/servers/' + uuid, function (err2, req2, res2, body2) {
            t.ifError(err2);

            t.ok(typeof (body2.unreserved_cpu)  === 'number');
            t.ok(typeof (body2.unreserved_ram)  === 'number');
            t.ok(typeof (body2.unreserved_disk) === 'number');

            t.done();
        });
    });
}


module.exports = {
    setUp: setup,
    'list servers with capacity': testListServersWithCapacity,
    'list servers with all': testListServersWithAll,
    'get server': testGetServer
};
