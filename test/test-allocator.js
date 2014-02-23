/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * test-allocator.js: Tests for server-selection endpoint.
 */

var http    = require('http');
var restify = require('restify');


var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var client;


var allocData = {
    vm: {
        vm_uuid: '7beee9e1-3488-4696-8a93-6403372bc150',
        ram: 128,
        owner_uuid: 'e1f0e74c-9f11-4d80-b6d1-74dcf1f5aafb'
    },
    image: {},
    package: {
        min_platform: {'7.0': '20130122T122401Z'}
    },
    nic_tags: ['external', 'admin']
};


function setup(callback) {
    client = restify.createJsonClient({
        agent: false,
        url: CNAPI_URL
    });

    client.basicAuth('admin', 'joypass123');

    callback();
}


function testAllocator(t) {
    client.post('/allocate', allocData, function (err, req, res, body) {
        if (err && err.statusCode !== 409)
            t.ifError(err);

        t.ok(body);

        if (body.code === 'InvalidArgument') {
            t.ok(/No allocatable servers found/.test(body.message));
            console.warn('Test requires COAL and an empty setup CN. Skipping.');
            // but look at the bright side, it wasn't a 500!
        } else {
            t.ok(body.server);
            t.ok(body.steps);
        }

        t.done();
    });
}


function testAllocatorWithServerUuids(t) {
    var data = deepCopy(allocData);
    data.servers = ['564d0b8e-6099-7648-351e-877faf6c56f6'];

    // this will always 409 since it's a headnode, and DAPI filters them out
    client.post('/allocate', data, function (er, req, res, body) {
        t.ok(er);
        t.equal(er.statusCode, 409);

        t.ok(body);
        t.equal(body.code, 'InvalidArgument');

        var steps = body.steps;

        client.get('/servers?headnode=true', function (er2, rq, rs, servers) {
            t.ifError(er2);

            var headnode = servers[0].uuid;
            t.deepEqual(steps[0].remaining, [headnode]);

            t.done();
         });
    });
}


function testMalformedVM(t) {
    var data = deepCopy(allocData);
    delete data.vm.vm_uuid;

    client.post('/allocate', data, function (err, req, res, body) {
        t.ok(err);
        t.equal(err.statusCode, 409);

        t.ok(body);
        t.equal(body.code, 'InvalidArgument');
        t.equal(body.message, '"vm.vm_uuid" is an invalid UUID');

        t.done();
    });
}


function testMalformedServerUuids(t) {
    var data = deepCopy(allocData);
    data.servers = ['b2e85bcb-6679-48bc-9ecb-8d8322b9d5d0', 'foo'];

    client.post('/allocate', data, function (err, req, res, body) {
        t.ok(err);
        t.equal(err.statusCode, 409);

        t.ok(body);
        t.equal(body.code, 'InvalidArgument');
        t.equal(body.message, 'invalid server UUID');

        t.done();
    });
}


function testMissingTags(t) {
    var data = deepCopy(allocData);
    delete data.nic_tags;

    client.post('/allocate', data, function (err, req, res, body) {
        t.ok(err);
        t.equal(err.statusCode, 409);

        t.ok(body);
        t.equal(body.code, 'MissingParameter');
        t.equal(body.message, '"nic_tags" is required');

        t.done();
    });
}


function testMissingPkg(t) {
    var data = deepCopy(allocData);
    delete data.package;

    client.post('/allocate', data, function (err, req, res, body) {
        t.ok(err);
        t.equal(err.statusCode, 409);

        t.ok(body);
        t.equal(body.code, 'MissingParameter');
        t.equal(body.message, '"package" is required');

        t.done();
    });
}


function testMissingImg(t) {
    var data = deepCopy(allocData);
    delete data.image;

    client.post('/allocate', data, function (err, req, res, body) {
        t.ok(err);
        t.equal(err.statusCode, 409);

        t.ok(body);
        t.equal(body.code, 'MissingParameter');
        t.equal(body.message, '"image" is required');

        t.done();
    });
}


function deepCopy(obj) {
    var type = typeof (obj);

    if (type !== 'object')
        return obj;

    if (obj === null)
        return null;

    var clone;
    if (Array.isArray(obj)) {
        clone = [];

        for (var i = obj.length - 1; i >= 0; i--) {
          clone[i] = deepCopy(obj[i]);
        }

    } else {
        clone = {};

        for (i in obj) {
            clone[i] = deepCopy(obj[i]);
        }
    }

    return clone;
}


module.exports = {
    setUp: setup,
    'allocate server': testAllocator,
    'allocate server with server UUIDs': testAllocatorWithServerUuids,
    'allocate with malformed VM': testMalformedVM,
    'allocate with malformed server UUIDs': testMalformedServerUuids,
    'allocate with missing nic_tags': testMissingTags,
    'allocate with missing package': testMissingPkg,
    'allocate with missing image': testMissingImg
};
