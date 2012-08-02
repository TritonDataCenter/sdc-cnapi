/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * zfs.test.js: Tests for ZFS endpoints
 */

var test = require('tap').test;
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

test('setup', function (t) {
    client = restify.createJsonClient({
        url: CNAPI_URL
    });
    client.basicAuth('admin', 'joypass123');
    t.end();
});

test('list servers', function (t) {
    client.get('/servers', function (err, req, res, servers) {
        t.notOk(err, 'valid response from GET /servers');
        t.equal(res.statusCode, 200, 'GET /servers returned 200');
        t.ok(servers);
        GZ = servers[0].uuid;
        t.end();
    });
});

test('list ZFS datasets', function (t) {
    client.get('/datasets/' + GZ, function (err, req, res, datasets) {
        t.notOk(err, 'valid response from GET /datasets');
        t.equal(res.statusCode, 200, 'GET /datasets returned 200');

        datasets.forEach(function (d) {
            t.type(d.name, 'string');
            t.type(d.type, 'string');
            t.type(d.used, 'string');
            t.type(d.avail, 'string');
            t.type(d.refer, 'string');
            t.type(d.mountpoint, 'string');
        });

        t.end();
    });
});

test('create ZFS dataset', function (t) {
    client.post('/datasets/' + GZ, { dataset: dataset },
    function (err, req, res, datasets) {
        t.notOk(err, 'create ' + dataset);
        t.equal(res.statusCode, 204, 'create returned 204');
        t.end();
    });
});

test('find created ZFS dataset', function (t) {
    client.get('/datasets/' + GZ, function (err, req, res, datasets) {
        t.notOk(err, 'valid response from GET /datasets');
        t.equal(res.statusCode, 200, 'GET /datasets returned 200');

        var found = false;

        datasets.forEach(function (d) {
            if (d.name === dataset)
                found = true;
        });

        t.ok(found, 'dataset ' + dataset + ' found in list');
        t.end();
    });
});

test('set ZFS properties', function (t) {
    var params = {
        properties: {
            quota: '5G'
        }
    };

    var uri = '/datasets/' + GZ + '/properties/' + encodeURIComponent(dataset);

    client.post(uri, params, function (err, req, res) {
        t.notOk(err, 'set ZFS quota on ' + dataset);
        t.equal(res.statusCode, 204, 'set properties returned 204');
        t.end();
    });
});

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

/* GET /datasets/:server/properties/:dataset */
test('get ZFS properties (single dataset)', function (t) {
    var uri = '/datasets/' + GZ + '/properties/' + encodeURIComponent(dataset);

    client.get(uri, function (err, req, res, properties) {
        t.notOk(err, 'get ZFS properties for ' + dataset);
        t.equal(res.statusCode, 200, 'get properties returned 200');

        t.equal(properties[dataset].quota, '5368709120',
            dataset + ' has 5G quota');
        t.ok(properties[dataset].mountpoint,
            dataset + ' has valid mountpoint');
        t.equal(properties[dataset].type, 'filesystem',
            dataset + ' is of type filesystem');

        t.notOk(properties['zones/var'], 'no properties for other datasets');

        t.end();
    });
});

/* GET /datasets/:server/properties?prop1=quota&prop2=mountpoint */
test('get specific ZFS properties (all datasets)', function (t) {
    var uri = '/datasets/' + GZ + '/properties?' +
        'prop1=quota&prop2=mountpoint';

    client.get(uri, function (err, req, res, properties) {
        t.notOk(err, 'get ZFS properties for ' + dataset);
        t.equal(res.statusCode, 200, 'get properties returned 200');

        t.equal(properties[dataset].quota, '5368709120',
            dataset + ' has 5G quota');

        // Check the properties of the created dataset as well as some
        // well-known datasets
        var datasets = [ dataset, 'zones/var', 'zones' ];

        datasets.forEach(function (ds) {
            t.ok(properties[ds].quota, ds + ' has valid quota');
            t.ok(properties[ds].mountpoint,
                ds + ' has valid mountpoint');
            t.notOk(properties[ds].type, ds + ' has extra property "type"');
        });

        t.end();
    });
});

/* GET /datasets/:server/properties/:dataset?prop1=quota&prop2=mountpoint */
test('get specific ZFS properties (single dataset)', function (t) {
    var uri = '/datasets/' + GZ + '/properties/' +
        encodeURIComponent(dataset) +
        '?prop1=quota&prop2=mountpoint';

    client.get(uri, function (err, req, res, properties) {
        t.notOk(err, 'get ZFS properties for ' + dataset);
        t.equal(res.statusCode, 200, 'get properties returned 200');

        t.equal(properties[dataset].quota, '5368709120',
            dataset + ' has 5G quota');
        t.ok(properties[dataset].mountpoint,
            dataset + ' has valid mountpoint');
        t.notOk(properties[dataset].type,
            dataset + ' has extra property "type"');

        t.notOk(properties['zones/var'], 'no properties for other datasets');

        t.end();
    });
});

test('destroy ZFS dataset', function (t) {
    var uri = '/datasets/' + GZ + '?' +
        encodeURIComponent('dataset=' + dataset);

    client.del(uri, function (err, req, res, datasets) {
        t.notOk(err, 'destroy ' + dataset);
        t.equal(res.statusCode, 204, 'destroy returned 204');
        t.end();
    });
});

test('lookup deleted ZFS dataset', function (t) {
    client.get('/datasets/' + GZ, function (err, req, res, datasets) {
        t.notOk(err, 'valid response from GET /datasets');
        t.equal(res.statusCode, 200, 'GET /datasets returned 200');

        var found = false;

        datasets.forEach(function (d) {
            if (d.name === dataset)
                found = true;
        });

        t.notOk(found, 'deleted dataset ' + dataset + ' not found in list');
        t.end();
    });
});

test('get ZFS pool(s)', function (t) {
    client.get('/zpools/' + GZ, function (err, req, res, zpools) {
        t.notOk(err, 'valid response from GET /zpools');
        t.equal(res.statusCode, 200, 'GET /zpools returned 200');

        zpools.forEach(function (z) {
            t.type(z.name, 'string');
            t.type(z.size, 'string');
            t.type(z.allocated, 'string');
            t.type(z.free, 'string');
            t.type(z.cap, 'string');
            t.type(z.health, 'string');
        });

        t.end();
    });
});

test('teardown', function (t) {
    t.end();
});
