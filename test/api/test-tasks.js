/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
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


/*
 * Test that we can create a ticket and immediately wait on it. The intent is
 * to exercise and reproduce the conditions described in CNAPI-722. However,
 * due to the timing required to hit, the bug is difficult to reproduce but it
 * is never the less useful to ensure that this continues to work into the
 * future.
 */

function testCreateTaskWaitImmediately(test) {
    test.expect(7);

    var id;

    async.waterfall([
        function (next) {
            client.post(servurl + '/nop', {}, onpost);

            function onpost(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.ok(obj.id);
                id = obj.id;
                next();
            }
        }, function (next) {
            client.get(sprintf('/tasks/%s/wait', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.equals(obj.status, 'complete');
                next();
            }
        }, function (next) {
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


function testWaitFinishedTask(test) {
    test.expect(7);

    var id;

    async.waterfall([
        function (next) {
            client.post(servurl + '/nop', {}, onpost);

            function onpost(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.ok(obj.id);
                id = obj.id;
                next();
            }
        }, function (next) {
            setTimeout(next, 1000);
        }, function (next) {
            client.get(sprintf('/tasks/%s/wait', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.equals(obj.status, 'complete');
                next();
            }
        }, function (next) {
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


function testWaitFinishedTaskError(test) {
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
            setTimeout(next, 1000);
        }, function (next) {
            client.get(sprintf('/tasks/%s/wait', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
                test.equals(obj.status, 'failure');
                next();
            }
        }, function (next) {
            client.get(sprintf('/tasks/%s', id), onget);

            function onget(err, req, res, obj) {
                test.ifError(err, 'no error');
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
                test.ifError(err);
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

function testTaskHistory(test) {
    test.expect(3);

    function getCb(err, req, res, obj) {
        test.ifError(err, 'no error');
        if (!err) {
            test.equal(res.statusCode, 200, '/task-history returns 200 OK');
            test.ok(Array.isArray(obj), 'task history is an array of tasks');
        }
        test.done();
    }

    client.get(sprintf('/servers/%s/task-history', serveruuid), getCb);
}

function testPauseCnAgent(test) {
    test.expect(2);

    function postCb(err, req, res, obj) {
        test.ifError(err, 'no error');
        if (!err) {
            test.equal(res.statusCode, 204, '/cn-agent/pause returns 204 OK');
        }
        test.done();
    }

    client.post(sprintf('/servers/%s/cn-agent/pause', serveruuid), {}, postCb);
}

function testResumeCnAgent(test) {
    test.expect(2);

    function postCb(err, req, res, obj) {
        test.ifError(err, 'no error');
        if (!err) {
            test.equal(res.statusCode, 204, '/cn-agent/resume returns 204 OK');
        }
        test.done();
    }

    client.post(sprintf('/servers/%s/cn-agent/resume', serveruuid), {}, postCb);
}

module.exports = {
    setUp: setup,
    tearDown: teardown,
    'create and wait on task': testCreateTask,
    'create and wait on task': testCreateTaskWaitImmediately,
    'create and wait on task already finished': testWaitFinishedTask,
    'create and wait on task already finished (with error)':
        testWaitFinishedTaskError,
    'execute task with error': testTaskError,
    'task expiry': testTaskExpiry,
    'create task and wait multiple times on it': testCreateTaskMultipleWait,
    'create task (with error) and wait multiple times on it':
        testCreateTaskMultipleWaitError,
    'task history': testTaskHistory,
    'pause cn-agent': testPauseCnAgent,
    'resume cn-agent': testResumeCnAgent
    // TODO: overlapping expiry times
    //   wait1    x------------x
    //   wait2            x------------x
    //
    //   wait1    x--------------x
    //   wait2             x------------x
    //
    //
    //   wait1         x-----------x
    //   wait2   x------------x
    //
    //
    //   wait1                       x-----------x
    //   wait2   x------------x
};
