/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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
        min_platform: {'7.0': '20130122T122401Z'},
        cpu_cap: 100
    },
    nic_tag_requirements: [ [ 'external' ], [ 'admin' ] ],
    nic_tags: [ 'external', 'admin' ]
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
        if (err) {
            callback(err);
            return;
        }

        headnodeUuid = servers[0].uuid;
        callback();
    });
}


function testAllocator(t) {
    callApiSuccess(t, allocData);
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


// package is optional
function testMissingPkg(t) {
    var data = deepCopy(allocData);
    delete data.package;

    callApiSuccess(t, data);
}


function testMissingImg(t) {
    var data = deepCopy(allocData);
    delete data.image;

    var msg = 'value is not an object. (was: [object Undefined])';
    callApiErr(t, '/allocate', data, 'image', msg);
}


function testMalformedNicTagRequirements1(t) {
    var data = deepCopy(allocData);
    data.nic_tag_requirements = [ 'external', 'admin' ];

    var msg = 'property "0": string value found, but a array is required';
    callApiErr(t, '/allocate', data, 'nic_tag_requirements', msg);
}


function testMalformedNicTagRequirements2(t) {
    var data = deepCopy(allocData);
    data.nic_tag_requirements = [ [ 'external' ], [ 5 ] ];

    var msg = 'property "1[0]": number value found, but a string is required';
    callApiErr(t, '/allocate', data, 'nic_tag_requirements', msg);
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
        if (err) {
            t.equal(err.statusCode, 500);
        }

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

    var serverUuid   = Object.keys(results.capacities)[0];
    var serverCap    = results.capacities[serverUuid];
    var expectedCaps = ['cpu', 'disk', 'ram'];

    t.ok(typeof (serverCap) === 'object');
    t.deepEqual(Object.keys(serverCap).sort(), expectedCaps);

    expectedCaps.forEach(function (name) {
        t.ok(typeof (serverCap[name]) === 'number');
    });
}


function callApiSuccess(t, data) {
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


function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}


module.exports = {
    setUp: setup,
    'allocate server': testAllocator,
    'allocate with malformed VM': testMalformedVM,
    'allocate with malformed tag requirements (array contains strings)':
        testMalformedNicTagRequirements1,
    'allocate with malformed tag requirements (inner array contains number)':
        testMalformedNicTagRequirements2,
    'allocate with malformed server UUIDs': testMalformedServerUuids,
    'allocate with missing nic_tags': testMissingTags,
    'allocate with missing package': testMissingPkg,
    'allocate with missing image': testMissingImg,
    'server capacity': testCapacity,
    'server capacity with malformed server Uuids': testCapacityBadServerUuids
};
