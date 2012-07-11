// Copyright 2012 Joyent, Inc.  All rights reserved.

var uuid = require('node-uuid'),
    util = require('util');

var CA = require('../lib/index').CA;
var restify = require('restify');


// --- Globals

var CA_URL = 'http://' + (process.env.CA_IP || '10.99.99.19') + ':23181';

var ca = null;
var customer = '930896af-bf8c-48d4-885c-6573a94b1853';
var instrumentation = null;

// --- Tests

exports.setUp = function (callback) {
    ca = new CA({
        url: CA_URL,
        retryOptions: {
            retries: 1,
            minTimeout: 1000
        }
    });
    callback();
};


exports.test_list_schema = function (test) {
    ca.listSchema(customer, function (err, schema) {
        test.ifError(err);
        test.ok(schema);
        test.done();
    });
};


exports.test_create_instrumentation_bad_params = function (test) {
    ca.createInstrumentation(customer, {}, function (err, instrumentation) {
        test.ok(err);
        test.ok(!instrumentation);
        test.equal(err.httpCode, 409);
        test.equal(err.restCode, 'InvalidArgument');
        test.ok(err.message);
        test.done();
    });
};


exports.test_create_instrumentation = function (test) {
    var params = {
        module: 'fs',
        stat: 'logical_ops',
        decomposition: 'latency'
    };
    ca.createInstrumentation(customer, params, function (err, inst) {
        test.ifError(err);
        test.ok(inst);
        var uri = inst.uri;
        instrumentation = uri.substr(uri.lastIndexOf('/') + 1);
        test.done();
    });
};


exports.test_list_instrumentations = function (test) {
    ca.listInstrumentations(customer, function (err, instrumentations) {
        test.ifError(err);
        test.ok(instrumentations);
        test.ok(instrumentations.length);
        var i = instrumentations[instrumentations.length - 1];
        test.equal(i.module, 'fs');
        test.equal(i.stat, 'logical_ops');
        test.done();
    });
};


exports.test_list_instrumentations_bogus_customer = function (test) {
    ca.listInstrumentations(uuid(), function (err, instrumentations) {
        test.ifError(err);
        test.ok(instrumentations);
        test.equal(instrumentations.length, 0);
        test.done();
    });
};


exports.test_get_instrumentation_bad = function (test) {
    ca.getInstrumentation(customer, uuid(), function (err, instrumentation) {
        test.ok(err);
        test.ok(!instrumentation);
        test.equal(err.httpCode, 404);
        test.equal(err.restCode, 'ResourceNotFound');
        test.ok(err.message);
        test.done();
    });
};


exports.test_get_instrumentation = function (test) {
    ca.getInstrumentation(customer, instrumentation, function (err, inst) {
        test.ifError(err);
        test.ok(inst);
        test.done();
    });
};


exports.test_get_heatmap = function (test) {
    ca.getHeatmap(customer, instrumentation, function (err, heatmap) {
        test.ifError(err);
        test.ok(heatmap);
        test.done();
    });
};


exports.test_get_heatmap_bad = function (test) {
    ca.getHeatmap(customer, uuid(), function (err, heatmap) {
        test.ok(err);
        test.ok(!heatmap);
        test.equal(err.httpCode, 404);
        test.equal(err.restCode, 'ResourceNotFound');
        test.ok(err.message);

        test.done();
    });
};


exports.test_get_heatmap_details_bad = function (test) {
    ca.getHeatmapDetails(customer, uuid(), {
        x: 10,
        y: 20
    }, function (err, heatmap) {
        test.ok(err);
        test.ok(!heatmap);
        test.equal(err.httpCode, 404);
        test.equal(err.restCode, 'ResourceNotFound');
        test.ok(err.message);
        test.done();
    });
};


exports.test_delete_instrumentation_bad = function (test) {
    ca.deleteInstrumentation(customer, uuid(), function (err) {
        test.ok(err);
        test.equal(err.httpCode, 404);
        test.equal(err.restCode, 'ResourceNotFound');
        test.ok(err.message);
        test.done();
    });
};


exports.test_clone_instrumentation = function (test) {
    ca.cloneInstrumentation(customer, instrumentation, function (err, inst) {
        test.ifError(err);
        ca.deleteInstrumentation(customer, inst.id, function (err) {
            test.ifError(err);
            test.done();
        });
    });
};


exports.test_delete_instrumentation = function (test) {
    ca.deleteInstrumentation(customer, instrumentation, function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.tearDown = function (callback) {
    callback();
};
