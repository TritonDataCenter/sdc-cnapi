/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * zfs.test.js: Tests for ZFS endpoints
 */

var Logger = require('bunyan');
var restify = require('restify');

var async = require('async'),
    cp = require('child_process'),
    fs = require('fs'),
    http = require('http'),
    path = require('path'),
    uuid = require('node-uuid');

var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.16');
var client;

var GZ;

var dataset = 'zones/' + uuid.v4();
var snapshotName = 'snappy';

function setup(callback) {
    client = restify.createJsonClient({
        url: CNAPI_URL
    });
    client.basicAuth('admin', 'joypass123');
    callback();
}


function teardown(callback) {
    callback();
}


function testListServers(test) {
    test.expect(4);
    client.get('/servers?headnode=true', function (err, req, res, servers) {
        test.equal(err, null, 'valid response from GET /servers');
        test.ok(res, 'got a response');
        test.equal(res.statusCode, 200, 'GET /servers returned 200');
        test.ok(servers);
        GZ = servers[0].uuid;
        test.done();
    });
}


function testListDatasets(test) {
    var uri = '/servers/' + GZ + '/datasets';
    client.get(uri, function (err, req, res, datasets) {
        test.equal(err, null, 'valid response from GET datasets');
        test.equal(res.statusCode, 200, 'GET datasets returned 200');

        datasets.forEach(function (d) {
            test.equal(typeof (d.name), 'string');
            test.equal(typeof (d.type), 'string');
            test.equal(typeof (d.used), 'string');
            test.equal(typeof (d.avail), 'string');
            test.equal(typeof (d.refer), 'string');
            test.equal(typeof (d.mountpoint), 'string');
        });

        test.done();
    });
}


function testCreateZFSDataset(test) {
    client.post('/servers/' + GZ + '/datasets', { dataset: dataset },
    function (err, req, res, datasets) {
        test.equal(err, null, 'create ' + dataset);
        test.equal(res.statusCode, 204, 'create returned 204');
        test.done();
    });
}


function testSnapshotZFSDataset(test) {
    client.post('/servers/' + GZ + '/datasets/'
        + encodeURIComponent(dataset) + '/snapshot',
    { name: snapshotName },
    function (err, req, res, datasets) {
        test.equal(err, null, 'create ' + dataset);
        test.equal(res.statusCode, 204, 'create returned 204');
        test.done();
    });
}


function testRollbackZFSDataset(test) {
    client.post('/servers/' + GZ + '/datasets/'
        + encodeURIComponent(dataset) + '/rollback',
    { name: snapshotName },
    function (err, req, res, datasets) {
        test.equal(err, null, 'create ' + dataset);
        test.equal(res.statusCode, 204, 'create returned 204');
        test.done();
    });
}


function testDestroyZFSSnapshot(test) {
    var uri = '/servers/' + GZ + '/datasets/'
        + encodeURIComponent(dataset + '@' + snapshotName);

    client.del(uri, function (err, req, res, datasets) {
        test.equal(err, null, 'destroy ' + dataset);
        test.equal(res.statusCode, 204, 'destroy returned 204');
        test.done();
    });
}


function testFindCreatedZFSDataset(test) {
    var uri = '/servers/' + GZ + '/datasets';
    client.get(uri, function (err, req, res, datasets) {
        test.equal(err, null, 'valid response from GET datasets');
        test.equal(res.statusCode, 200, 'GET datasets returned 200');

        var found = false;

        datasets.forEach(function (d) {
            if (d.name === dataset) {
                found = true;
            }
        });

        test.ok(found, 'dataset ' + dataset + ' found in list');
        test.done();
    });
}


function testSetZFSProperties(test) {
    var params = {
        properties: {
            quota: '5G'
        }
    };

    var uri = '/servers/' + GZ + '/datasets/'
        + encodeURIComponent(dataset) + '/properties';

    client.post(uri, params, function (err, req, res) {
        test.equal(err, null, 'set ZFS quota on ' + dataset);
        test.equal(res.statusCode, 204, 'set properties returned 204');
        test.done();
    });
}


/* GET /datasets/:server/properties/:dataset */
function testGetZfsPropertySingle(test) {
    var uri = '/servers/' + GZ + '/datasets/'
        + encodeURIComponent(dataset) + '/properties';

    client.get(uri, function (err, req, res, properties) {
        test.equal(err, null, 'get ZFS properties for ' + dataset);
        test.equal(res.statusCode, 200, 'get properties returned 200');

        test.equal(properties[dataset].quota, '5368709120',
            dataset + ' has 5G quota');
        test.ok(properties[dataset].mountpoint,
            dataset + ' has valid mountpoint');
        test.equal(properties[dataset].type, 'filesystem',
            dataset + ' is of type filesystem');

        test.equal(
            properties['zones/var'],
            undefined, 'no properties for other datasets');

        test.done();
    });
}


/* GET /datasets/:server/properties?prop1=quota&prop2=mountpoint */
function testGetZfsPropertySpecificAll(test) {
    var uri = '/servers/' + GZ + '/dataset-properties?' +
            'prop1=quota&prop2=mountpoint';

    client.get(uri, function (err, req, res, properties) {
        test.equal(err, null, 'get ZFS properties for ' + dataset);
        test.equal(res.statusCode, 200, 'get properties returned 200');

        test.equal(properties[dataset].quota, '5368709120',
            dataset + ' has 5G quota');

        // Check the properties of the created dataset as well as some
        // well-known datasets
        var datasets = [ dataset, 'zones/var', 'zones' ];

        datasets.forEach(function (ds) {
            test.ok(properties[ds].quota, ds + ' has valid quota');
            test.ok(properties[ds].mountpoint,
                ds + ' has valid mountpoint');
            test.equal(
                properties[ds].type, undefined,
                ds + ' has extra property "type"');
        });

        test.done();
    });
}


/* GET /datasets/:server/properties/:dataset?prop1=quota&prop2=mountpoint */
function testGetZfsPropertySpecificSingle(test) {
    var uri = '/servers/' + GZ + '/datasets/' + encodeURIComponent(dataset) +
        '/properties' + '?prop1=quota&prop2=mountpoint';

    client.get(uri, function (err, req, res, properties) {
        test.equal(err, null, 'get ZFS properties for ' + dataset);
        test.equal(res.statusCode, 200, 'get properties returned 200');

        test.equal(properties[dataset].quota, '5368709120',
            dataset + ' has 5G quota');
        test.ok(properties[dataset].mountpoint,
            dataset + ' has valid mountpoint');
        test.equal(properties[dataset].type, undefined,
            dataset + ' has extra property "type"');

        test.equal(
            properties['zones/var'],
            undefined, 'no properties for other datasets');

        test.done();
    });
}


function testDestroyZFSDataset(test) {
    var uri = '/servers/' + GZ + '/datasets/' + encodeURIComponent(dataset);

    client.del(uri, function (err, req, res, datasets) {
        test.equal(err, null, 'destroy ' + dataset);
        test.equal(res.statusCode, 204, 'destroy returned 204');
        test.done();
    });
}


function testLookupDeletedZFSDataset(test) {
    client.get('/servers/' + GZ + '/datasets',
        function (err, req, res, datasets) {
            test.equal(err, null, 'valid response from GET datasets');
            test.equal(res.statusCode, 200, 'GET datasets returned 200');

            var found = false;

            datasets.forEach(function (d) {
                if (d.name === dataset)
                    found = true;
            });

            test.equal(
                found, false,
                'deleted dataset ' + dataset + ' not found in list');
            test.done();
        });
}


function testGetZFSPools(test) {
    client.get('/servers/' + GZ + '/zpools', function (err, req, res, zpools) {
        test.equal(err, null, 'valid response from GET zpools');
        test.equal(res.statusCode, 200, 'GET zpools returned 200');

        zpools.forEach(function (z) {
            test.equal(typeof (z.name), 'string');
            test.equal(typeof (z.size), 'string');
            test.equal(typeof (z.allocated), 'string');
            test.equal(typeof (z.free), 'string');
            test.equal(typeof (z.cap), 'string');
            test.equal(typeof (z.health), 'string');
        });

        test.done();
    });
}


module.exports = {
    setUp: setup,
    tearDown: teardown,
    'list servers': testListServers,
    'list datasets': testListDatasets,
    'create ZFS dataset': testCreateZFSDataset,
    'create snapshot': testSnapshotZFSDataset,
    'rollback snapshot': testRollbackZFSDataset,
    'destroy snapshot': testDestroyZFSSnapshot,
    'find created ZFS dataset': testFindCreatedZFSDataset,
    'set ZFS properties': testSetZFSProperties,
    'get ZFS properties (single dataset)': testGetZfsPropertySingle,
    'get specific ZFS properties (all datasets)':
        testGetZfsPropertySpecificAll,
    'get specific ZFS properties (single dataset)':
        testGetZfsPropertySpecificSingle,
    'destroy ZFS dataset': testDestroyZFSDataset,
    'lookup deleted ZFS dataset': testLookupDeletedZFSDataset,
    'get ZFS pool(s)': testGetZFSPools
};


/* XXX This test is causing a 'maxBuffer exceeded' exception */
// /* GET /datasets/:server/properties */
// test('get ZFS properties (all datasets)', {timeout: 60000}, function (t) {
//    var uri = '/datasets/' + GZ + '/properties';
//
//    client.get(uri, function (err, req, res, properties) {
//        t.notOk(err, 'get ZFS properties for ' + dataset);
//        t.equal(res.statusCode, 200, 'get properties returned 200');
//
//        t.equal(properties[dataset].quota, '5368709120',
//            dataset + ' has 5G quota');
//
//        // Check the properties of the created dataset as well as some
//        // well-known datasets
//        var datasets = [ dataset, 'zones/var', 'zones' ];
//
//        datasets.forEach(function (ds) {
//            t.ok(properties[ds].mountpoint,
//                ds + ' has valid mountpoint');
//            t.equal(properties[ds].type, 'filesystem',
//                ds + ' is of type filesystem');
//        });
//
//        t.end();
//    });
// });
