// Copyright 2012 Joyent, Inc.  All rights reserved.

var Logger = require('bunyan');
var uuid = require('node-uuid'),
    util = require('util'),
    clone = require('clone');

var UFDS = require('../lib/index').UFDS;


// --- Globals

var UFDS_URL = 'ldaps://' + (process.env.UFDS_IP || '10.99.99.13');

var ufds;
var ADMIN_UUID = '930896af-bf8c-48d4-885c-6573a94b1853';
var SSH_KEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAABIwAAAIEAvad19ePSDckmgmo6Unqmd8' +
    'n2G7o1794VN3FazVhV09yooXIuUhA+7OmT7ChiHueayxSubgL2MrO/HvvF/GGVUs/t3e0u4' +
    '5YwRC51EVhyDuqthVJWjKrYxgDMbHru8fc1oV51l0bKdmvmJWbA/VyeJvstoX+eiSGT3Jge' +
    'egSMVtc= mark@foo.local';

var ADMIN_PWD = process.env.ADMIN_PWD || 'joypass123';


// --- Tests

exports.setUp = function (callback) {
    ufds = new UFDS({
        url: UFDS_URL,
        bindDN: 'cn=root',
        bindPassword: 'secret',
        log: new Logger({
            name: 'ufds_unit_test',
            stream: process.stderr,
            level: (process.env.LOG_LEVEL || 'info'),
            serializers: Logger.stdSerializers
        })
    });
    ufds.on('ready', function () {
        callback();
    });
    ufds.on('error', function (err) {
        callback(err);
    });
};


exports.testGetUser = function (test) {
    ufds.getUser('admin', function (err, user) {
        test.ifError(err);
        test.equal(user.login, 'admin');
        test.ok(user.isAdmin);
        test.ok(user.isAdmin());
        test.ok(user.groups);
        test.ok(user.groups());
        test.equal(user.groups().length, 1);
        test.equal(user.groups()[0], 'operators');
        ufds.getUser(user, function (err, user2) {
            test.ifError(err);
            test.deepEqual(user, user2);
            test.done();
        });
    });
};


exports.testGetUserByUuid = function (test) {
    ufds.getUser(ADMIN_UUID, function (err, user) {
        test.ifError(err);
        test.equal(user.login, 'admin');
        test.ok(user.isAdmin);
        test.ok(user.isAdmin());
        test.done();
    });
};


exports.testGetUserNotFound = function (test) {
    ufds.getUser(uuid(), function (err, user) {
        test.ok(err);
        test.equal(err.httpCode, 404);
        test.equal(err.restCode, 'ResourceNotFound');
        test.ok(err.message);
        test.ok(!user);
        test.done();
    });
};


exports.testAuthenticate = function (test) {
    ufds.authenticate('admin', ADMIN_PWD, function (err, user) {
        test.ifError(err);
        test.ok(user);
        ufds.getUser('admin', function (err, user2) {
            test.ifError(err);
            test.equal(user.login, user2.login);
            test.done();
        });
    });
};


exports.testAuthenticateByUuid = function (test) {
    ufds.authenticate(ADMIN_UUID, ADMIN_PWD, function (err, user) {
        test.ifError(err);
        test.ok(user);
        test.equal(user.login, 'admin');
        test.ok(user.isAdmin());
        user.authenticate(ADMIN_PWD, function (err) {
            test.ifError(err);
            test.done();
        });
    });
};


exports.test_add_key = function (test) {
    ufds.getUser('admin', function (err, user) {
        test.ifError(err);
        user.addKey(SSH_KEY, function (err, key) {
            test.ifError(err);
            test.ok(key);
            test.equal(key.openssh, SSH_KEY);
            test.done();
        });
    });
};


exports.testListAndGetKeys = function (test) {
    ufds.getUser('admin', function (err, user) {
        test.ifError(err);
        user.listKeys(function (err, keys) {
            test.ifError(err);
            test.ok(keys);
            test.ok(keys.length);
            test.equal(keys[0].openssh, SSH_KEY);
            user.getKey(keys[0].fingerprint, function (err, key) {
                test.ifError(err);
                test.ok(key);
                test.deepEqual(keys[0], key);
                test.done();
            });
        });
    });
};


exports.testDelKey = function (test) {
    ufds.getUser('admin', function (err, user) {
        test.ifError(err);
        user.listKeys(function (err, keys) {
            test.ifError(err);
            user.deleteKey(keys[0], function (err) {
                test.ifError(err);
                test.done();
            });
        });
    });
};


exports.testCrudUser = function (test) {
    var entry = {
        login: 'a' + uuid().replace('-', '').substr(0, 7),
        email: uuid() + '@devnull.com',
        userpassword: 'secret'
    };
    ufds.addUser(entry, function (err, user) {
        test.ifError(err);
        test.ok(user);
        test.ok(user.uuid);
        user.phone = '+1 (206) 555-1212';
        user.save(function (err) {
            test.ifError(err);
            user.destroy(function (err) {
                test.ifError(err);
                test.done();
            });
        });
    });
};


exports.testCrudLimit = function (test) {
    ufds.getUser('admin', function (err, user) {
        test.ifError(err);
        test.ok(user);
        user.addLimit(
          {datacenter: 'coal', smartos: '123'},
          function (err, limit) {
            test.ifError(err);
            test.ok(limit);
            test.ok(limit.smartos);
            user.listLimits(function (err, limits) {
                test.ifError(err);
                test.ok(limits);
                test.ok(limits.length);
                test.ok(limits[0].smartos);
                limits[0].nodejs = 234;
                user.updateLimit(limits[0], function (err) {
                    test.ifError(err);
                    user.getLimit(limits[0].datacenter, function (err, limit) {
                        test.ifError(err);
                        test.ok(limit);
                        test.ok(limit.smartos);
                        test.ok(limit.nodejs);
                        user.deleteLimit(limit, function (err) {
                            test.ifError(err);
                            test.done();
                        });
                    });
                });
            });
        });
    });
};


exports.tearDown = function (callback) {
    ufds.close(function () {
        callback();
    });
};
