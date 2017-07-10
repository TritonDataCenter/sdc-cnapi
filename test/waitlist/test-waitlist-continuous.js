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

var async = require('async');
var cp = require('child_process');
var fs = require('fs');
var http = require('http');
var path = require('path');
var sprintf = require('sprintf').sprintf;

var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var client;

var wlurl;
var serveruuid;

function setup(callback) {
    client = restify.createJsonClient({
        agent: false,
        url: CNAPI_URL
    });
    client.basicAuth('admin', 'joypass123');

    if (!wlurl) {
        client.get('/servers?headnode=true', function (err, req, res, servers) {
            wlurl = '/servers/' + servers[0].uuid + '/tickets';
            serveruuid = servers[0].uuid;

            deleteAllTickets(callback);
        });
    } else {
        deleteAllTickets(callback);
    }
}


function teardown(callback) {
    callback();
}


function deleteAllTickets(callback) {
    client.del(wlurl + '?force=true', function delcb(err, req, res) {
        callback(err);
    });
}

function testContinuosCreateWaitRelease(test) {
    var ticketuuid;
    var count = 0;
    var timeout;

    async.whilst(function () { return count < 100; }, oncycle, onend);

    function oncycle(cb) {
        // create ticket
        // wait for ticket
        // release ticket

        async.waterfall([
            incrCount,
            create,
            wait,
            release,
            get
        ],
        function (err) {
            console.log('');
            cb();
        });
    }

    function incrCount(cb) {
        count++;
        cb();
    }

    function create(cb) {
        var ticketPayload = {
            scope: 'test-continuous-create-wait-release',
            id: '111',
            expires_at:
                (new Date((new Date().valueOf()) + 60*1000)).toISOString()
        };

        client.post(wlurl, ticketPayload, onpost);

        function onpost(err, req, res, ticket) {
            test.equal(err, null, 'no error');
            test.equal(res.statusCode, 202,
                       'POST waitlist ticket returned 202');
            test.ok(res, 'got a response');
            test.ok(ticket, 'got an ticket');
            test.ok(ticket.uuid, 'got a ticket uuid');

            ticketuuid = ticket.uuid;
            console.log('create (%d) %s', count, ticketuuid);
            cb();
        }
    }

    function wait(cb) {
//         var timeout = setTimeout(function () {
//             console.log("oh oh");
//             test.ok(false, 'timed out waiting for active ticket');
//         }, 2000);
        var waiturl = sprintf('/tickets/%s/wait', ticketuuid);
        client.get(waiturl, getcb);
        function getcb(err) {
            clearTimeout(timeout);
            test.equal(err, null, 'no error');
            console.log('wait (%d) %s', count, ticketuuid);
            cb();
        }
    }

    function release(cb) {
        var puturl = sprintf('/tickets/%s/release', ticketuuid);
        client.put(puturl, putcb);
        function putcb(err) {
            test.equal(err, null, 'no error');
            console.log('release (%d) %s', count, ticketuuid);
            cb();
        }
    }

    function get(cb) {
        var geturl = sprintf('/tickets/%s', ticketuuid);
        client.get(geturl, getcb);
        function getcb(err, req, res, ticket) {
            console.log('verify (%d) %s', count, ticketuuid);
            test.equal(ticket.status, 'finished');
            cb();
        }
    }

    function onend(err) {
        test.equal(err, null, 'no error');
        test.done();
    }
}


module.exports = {
    setUp: setup,
    tearDown: teardown,
    'continuously create, wait and release tickets':
        testContinuosCreateWaitRelease
};
