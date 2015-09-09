/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var Logger = require('bunyan');
var restify = require('restify');
var assert = require('assert-plus');

var async = require('async');
var cp = require('child_process');
var fs = require('fs');
var http = require('http');
var util = require('util');
var path = require('path');
var uuid = require('node-uuid');
var sprintf = require('sprintf').sprintf;

var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var client;

var servurl;
var serveruuid;

var ticketuuid;

function setup(callback) {
    client = restify.createJsonClient({
        agent: false,
        url: CNAPI_URL
    });
    client.basicAuth('admin', 'joypass123');

    if (!servurl) {
        client.get('/servers?headnode=true', function (err, req, res, servers) {
            servurl = '/servers/' + servers[0].uuid;
            serveruuid = servers[0].uuid;
            callback();
        });
    } else {
        callback();
    }
}


function teardown(callback) {
    callback();
}


function testCreateTask(test) {
    test.expect(7);

    var id;

    async.waterfall([
        function (next) {
            client.post(servurl + '/nop', { sleep: 1 }, onpost);

            function onpost(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.ok(obj.id);
                id = obj.id;
                next();
            }
        }, function (next) {
            client.get(sprintf('/tasks/%s', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.equals(obj.status, 'active');
                next();
            }
        }, function (next) {
            client.get(sprintf('/tasks/%s/wait', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.equals(obj.status, 'complete');
                next();
            }
        }
    ],
    function (err) {
        test.ifError(err, 'no error');
        test.done();
    });
}


function testCreateTaskMultipleWait(test) {
    test.expect(12);

    var id;

    async.waterfall([
        function (next) {
            client.post(servurl + '/nop', { sleep: 1 }, onpost);

            function onpost(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.ok(obj.id);
                id = obj.id;
                next();
            }
        }, function (next) {
            client.get(sprintf('/tasks/%s', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.equals(obj.status, 'active');
                next();
            }
        }, function (next) {

            async.parallel([
               function (pnext) {
                   client.get(sprintf('/tasks/%s/wait', id), onget);
                   function onget(err, req, res, obj) {
                       test.ifError(err, 'no error');
                       test.equals(obj.status, 'complete');
                       pnext();
                   }
               }, function (pnext) {
                   client.get(sprintf('/tasks/%s/wait', id), onget);
                   function onget(err, req, res, obj) {
                       test.ifError(err, 'no error');
                       test.equals(obj.status, 'complete');
                       pnext();
                   }
               }, function (pnext) {
                   client.get(sprintf('/tasks/%s/wait', id), onget);
                   function onget(err, req, res, obj) {
                       test.ifError(err, 'no error');
                       test.equals(obj.status, 'complete');
                       pnext();
                   }
               }
            ], function (err) {
               test.ifError(err, 'no error');
               next();
            });
        }
    ],
    function (err) {
        test.ifError(err, 'no error');
        test.done();
    });
}


function testTaskError(test) {
    test.expect(4);

    var id;

    async.waterfall([
        function (next) {
            client.post(servurl + '/nop', { error: 'die' }, onpost);

            function onpost(err, req, res, obj) {
                test.ok(obj.id);
                id = obj.id;
                next();
            }
        }, function (next) {
            client.get(sprintf('/tasks/%s/wait', id), onget);

            function onget(err, req, res, obj) {
                test.deepEqual(obj.status, 'failure');
                next();
            }
        }, function (next) {
            client.get(sprintf('/tasks/%s', id), onget);

            function onget(err, req, res, obj) {
                test.equals(obj.status, 'failure');
                next();
            }
        }
    ],
    function (err) {
        test.ifError(err, 'no error');
        test.done();
    });
}


function testCreateTaskMultipleWaitError(test) {
    test.expect(7);

    var id;

    async.waterfall([
        function (next) {
            client.post(servurl + '/nop', { error: 'die' }, onpost);

            function onpost(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.ok(obj.id);
                id = obj.id;
                next();
            }
        }, function (next) {

            async.parallel([
               function (pnext) {
                   client.get(sprintf('/tasks/%s/wait', id), onget);
                   function onget(err, req, res, obj) {
                       test.equals(obj.status, 'failure');
                       pnext();
                   }
               }, function (pnext) {
                   client.get(sprintf('/tasks/%s/wait', id), onget);
                   function onget(err, req, res, obj) {
                       test.equals(obj.status, 'failure');
                       pnext();
                   }
               }, function (pnext) {
                   client.get(sprintf('/tasks/%s/wait', id), onget);
                   function onget(err, req, res, obj) {
                       test.equals(obj.status, 'failure');
                       pnext();
                   }
               }
            ], function (err) {
               next();
            });
        }, function (next) {
            client.get(sprintf('/tasks/%s', id), onget);

            function onget(err, req, res, obj) {
                test.equals(obj.status, 'failure');
                next();
            }
        }
    ],
    function (err) {
        test.ifError(err, 'no error');
        test.done();
    });
}


function testTaskExpiry(test) {
    test.expect(9);

    var id;

    async.waterfall([
        // Create a task that will sleep at least 3 seconds
        function (next) {
            client.post(servurl + '/nop', { sleep: 3 }, onpost);

            function onpost(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.ok(obj.id);
                id = obj.id;
                next();
            }
        },

        // Wait for 1 second before timing out, check that we do
        function (next) {
            client.get(sprintf('/tasks/%s/wait?timeout=1', id), onget);

            function onget(err, req, res, obj) {
                test.ok(err);
                test.equals(obj.status, 'active');
                next();
            }
        },

        // Wait for 3 more seconds before timing out, check that we do not
        function (next) {
            client.get(sprintf('/tasks/%s/wait?timeout=3', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.equals(obj.status, 'complete');
                next();
            }
        },

        // Explicitly fetching task should corroborate above
        function (next) {
            client.get(sprintf('/tasks/%s', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.equals(obj.status, 'complete');
                next();
            }
        }
    ],
    function (err) {
        test.ifError(err, 'no error');
        test.done();
    });
}


module.exports = {
    setUp: setup,
    tearDown: teardown,
    'create and wait on task': testCreateTask,
    'create task and wait multiple times on it': testCreateTaskMultipleWait,
    'execute task with error': testTaskError,
    'execute task with error many waits': testTaskError,
    'task expiry': testTaskExpiry,
    'create task and wait multiple times on it': testCreateTaskMultipleWaitError
};
