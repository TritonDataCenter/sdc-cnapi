// Copyright 2012 Joyent, Inc.  All rights reserved.

var Logger = require('bunyan'),
    uuid = require('node-uuid'),
    util = require('util'),
    clone = require('clone');

var Package = require('../lib/index').Package;


// --- Globals

var UFDS_URL = 'ldaps://' + (process.env.UFDS_IP || '10.99.99.13');
var pack;

var entry = {
    name: 'regular_128',
    version: '1.0.0',
    max_physical_memory: 128,
    quota: 5120,
    max_swap: 256,
    cpu_cap: 350,
    max_lwps: 2000,
    zfs_io_priority: 1,
    'default': true,
    vcpus: 1,
    urn: 'sdc:' + uuid() + ':regular_128:1.0.0',
    active: true
};

var another_entry = {
    name: 'regular_256',
    version: '1.0.0',
    max_physical_memory: 256,
    quota: 5120,
    max_swap: 512,
    cpu_cap: 350,
    max_lwps: 2000,
    zfs_io_priority: 1,
    'default': true,
    vcpus: 1,
    urn: 'sdc:' + uuid() + ':regular_256:1.0.0',
    active: true
};

var PKG;

// --- Tests

exports.setUp = function (callback) {
    pack = new Package({
        url: UFDS_URL,
        bindDN: 'cn=root',
        bindPassword: 'secret',
        log: new Logger({
            name: 'ufds_packages_unit_test',
            stream: process.stderr,
            level: (process.env.LOG_LEVEL || 'info'),
            serializers: Logger.stdSerializers
        })
    });
    pack.ufds.on('ready', function () {
        callback();
    });
    pack.ufds.on('error', function (err) {
        callback(err);
    });
};


exports.test_create_package = function (t) {
    pack.add(entry, function (err, pkg) {
        t.ifError(err);
        t.ok(pkg);
        t.ok(pkg.uuid);
        t.equal(pkg.vcpus, 1);
        t.equal(pkg.max_swap, 256);
        PKG = pkg;
        t.done();
    });
};


exports.test_get_package_by_urn = function (t) {
    pack.get(PKG.urn, function (err, pkg) {
        t.ifError(err);
        t.ok(pkg);
        t.equal(pkg.uuid, PKG.uuid);
        t.equal(pkg.urn, PKG.urn);
        t.done();
    });
};


exports.test_modify_mutable_attribute = function (t) {
    var changes = clone(PKG);
    changes.active = 'false';
    changes['default'] = 'false';
    pack.update(PKG, changes, function (err) {
        t.ifError(err);
        pack.get(PKG.uuid, function (err, pkg) {
            t.ifError(err);
            t.ok(pkg);
            t.equal(pkg.active, 'false');
            t.equal(pkg['default'], 'false');
            PKG = pkg;
            t.done();
        });
    });
};


exports.test_modify_immutable_attribute = function (t) {
    var changes = clone(PKG);
    changes.max_physical_memory = 256;
    pack.update(PKG, changes, function (err) {
        t.ok(err);
        t.ok(/immutable/.test(err.message));
        t.ok(/max_physical_memory/.test(err.message));
        t.done();
    });
};


exports.test_delete_package = function (t) {
    pack.del(PKG, function (err) {
        t.ok(err);
        t.equal(err.message, 'Packages cannot be deleted');
        t.equal(err.statusCode, 405);
        // Verify ufds straight deletion doesn't work too:
        pack.ufds.del(PKG.dn, function (err) {
            t.ok(err);
            t.ok(/immutable/.test(err.message));
            t.done();
        });
    });
};


exports.test_list_packages = function (t) {
    pack.add(another_entry, function (err, pkg) {
        t.ifError(err);
        t.ok(pkg);
        t.ok(pkg.uuid);
        pack.list(function (err2, packages) {
            t.ifError(err2);
            t.ok(util.isArray(packages));
            t.done();
        });
    });
};


exports.test_urn_must_be_unique = function (t) {
    var changes = clone(PKG);
    delete changes.dn;
    pack.add(changes, function (err, pkg) {
        t.ok(err);
        t.ok(/already exists/.test(err.message));
        t.done();
    });
};


exports.test_instantiate_with_ufds_instance = function (t) {
    var instance = new Package(pack.ufds);
    t.ok(instance);
    t.done();
};

exports.tearDown = function (callback) {
    pack.ufds.close(function () {
        callback();
    });
};
