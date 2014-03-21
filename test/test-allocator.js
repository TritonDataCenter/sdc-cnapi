/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * test-allocator.js: Tests for server-selection endpoint.
 */

var http    = require('http');
var restify = require('restify');


var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var headnodeUuid;
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

    if (headnodeUuid) {
        callback();
        return;
    }

    client.get('/servers?headnode=true', function (err, req, res, servers) {
        headnodeUuid = servers[0].uuid;
        callback();
    });
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
    data.servers = [headnodeUuid];

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

    callApiErr(t, '/allocate', data, 'vm', '"vm.vm_uuid" is an invalid UUID');
}


function testMalformedServerUuids(t) {
    var data = deepCopy(allocData);
    data.servers = ['b2e85bcb-6679-48bc-9ecb-8d8322b9d5d0', 'foo'];

    callApiErr(t, '/allocate', data, 'servers', 'invalid server UUID');
}


function testMissingTags(t) {
    var data = deepCopy(allocData);
    delete data.nic_tags;

    callApiErr(t, '/allocate', data, 'nic_tags', 'value was not an array');
}


function testMissingPkg(t) {
    var data = deepCopy(allocData);
    delete data.package;

    var msg = 'value is not an object. (was: [object Undefined])';
    callApiErr(t, '/allocate', data, 'package', msg);
}


function testMissingImg(t) {
    var data = deepCopy(allocData);
    delete data.image;

    var msg = 'value is not an object. (was: [object Undefined])';
    callApiErr(t, '/allocate', data, 'image', msg);
}


// Unfortunately we cannot make too many assumptions about the setup this is
// tested on, so the tests are fairly generic.
function testCapacity(t) {
    client.post('/capacity', {}, function (err, req, res, body) {
        t.ifError(err);

        validateCapacityResults(t, body);

        t.done();
    });
}


function testCapacityWithServerUuids(t) {
    var data = { servers: [headnodeUuid] };

    client.post('/capacity', data, function (err, req, res, body) {
        t.ifError(err);

        validateCapacityResults(t, body);

        t.done();
    });
}


function testCapacityBadServerUuids(t) {
    var data = { servers: ['b2e85bcb-6679-48bc-9ecb-8d8322b9d5d0', 'foo']};

    callApiErr(t, '/capacity', data, 'servers', 'invalid server UUID');
}


function callApiErr(t, path, data, errField, errMsg) {
    client.post(path, data, function (err, req, res, body) {
        t.ok(err);
        t.equal(err.statusCode, 500);

        var expected = {
            code: 'InvalidParameters',
            message: 'Request parameters failed validation',
            errors: [ {
                field: errField,
                code: 'Invalid',
                message: errMsg
            } ]
        };
        t.deepEqual(body, expected);

        t.done();
    });
}


function validateCapacityResults(t, results) {
    t.ok(results);
    t.ok(typeof (results.capacities) === 'object');
    t.deepEqual(results.errors, {});

    var serverUuid   = Object.keys(results.capacities)[0];
    var serverCap    = results.capacities[serverUuid];
    var expectedCaps = ['cpu', 'disk', 'ram'];

    t.ok(typeof (serverCap) === 'object');
    t.deepEqual(Object.keys(serverCap).sort(), expectedCaps);

    expectedCaps.forEach(function (name) {
        t.ok(typeof (serverCap[name]) === 'number');
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
    'allocate with missing image': testMissingImg,
    'server capacity': testCapacity,
    'server capacity with malformed server Uuids': testCapacityBadServerUuids
};
