// Copyright 2012 Joyent, Inc.  All rights reserved.

var Logger = require('bunyan'),
    restify = require('restify'),
    uuid = require('node-uuid'),
    IMGAPI = require('../lib/index').IMGAPI,
    util = require('util');


// --- Globals

var IMGAPI_URL = 'https://datasets.joyent.com';

var imgapi, IMAGES;

exports.setUp = function (callback) {
    var logger = new Logger({
            name: 'imgapi_unit_test',
            stream: process.stderr,
            level: (process.env.LOG_LEVEL || 'info'),
            serializers: Logger.stdSerializers
    });

    imgapi = new IMGAPI({
        url: IMGAPI_URL,
        retry: {
            retries: 1,
            minTimeout: 1000
        },
        log: logger
    });

    callback();
};


exports.test_list_images = function (t) {
    imgapi.listImages(function (err, images) {
        t.ifError(err, 'listImages Error');
        t.ok(images, 'listImages OK');
        IMAGES = images;
        IMAGES.forEach(function (ds) {
            t.ok(ds.name, 'ds.name OK');
            t.ok(ds.version, 'ds.version OK');
            t.ok(ds.os, 'ds.os OK');
            t.ok(ds.urn, 'ds.urn OK');
            t.ok(ds.uuid, 'ds.uuid OK');
        });
        t.done();
    });
};

exports.test_get_image = function (t) {
    imgapi.getImage(IMAGES[0].uuid, function (err, img) {
        t.ifError(err, 'getImage Error');
        t.ok(img, 'getImage OK');
        t.equal(img.urn, IMAGES[0].urn);
        t.done();
    });
};
