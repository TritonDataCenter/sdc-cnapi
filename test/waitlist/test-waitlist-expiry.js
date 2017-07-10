/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * test-waitlist-expiry.js
 */

var Logger = require('bunyan');
var restify = require('restify');

var async = require('async');
var cp = require('child_process');
var fs = require('fs');
var http = require('http');
var path = require('path');
var uuid = require('libuuid');
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


function testExpireSingleTicket(test) {
    var expireTimeSeconds = 3;
    var ticketPayload = {
        scope: 'test-expire-single-ticket',
        id: '123',
        expires_at: (
            new Date((new Date().valueOf()) +
                      expireTimeSeconds * 1000)).toISOString()
    };
    var ticket;

    async.waterfall([
        function (wfcb) {
            // create the ticket
            client.post(wlurl, ticketPayload, function (err, req, res, t) {
                test.deepEqual(err, null);
                test.equal(res.statusCode, 202,
                           'POST waitlist ticket returned 202');
                test.ok(res, 'got a response');
                test.ok(t, 'got an ticket');
                test.ok(t.uuid, 'got a ticket uuid');

                wfcb();
            });
        },
        function (wfcb) {
            client.get(wlurl, function (err, req, res, waitlist) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');
                test.ok(waitlist.length);

                ticket = waitlist[0];
                console.dir(ticket);
                test.ok(ticket);
                test.deepEqual(ticket.status, 'active');

                wfcb();
            });
        },
        function (wfcb) {
            setTimeout(function () {
                wfcb();
            }, (2+expireTimeSeconds) * 1000);
        },
        function (wfcb) {
            client.get(wlurl, function (err, req, res, waitlist) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');
                test.ok(waitlist.length);

                ticket = waitlist[0];
                test.ok(ticket);

                wfcb();
            });
        },
        function (wfcb) {
            test.deepEqual(ticket.status, 'expired');
            wfcb();
        }
    ],
    function (error) {
        test.equal(error, null);
        test.done();
    });
}


function testExpireSingleTicketStartNext(test) {
    var expireTimeSeconds = 10;
    var expireTimeSeconds2 = 24;

    var ticketPayload = {
        scope: 'test-expire-single-ticket',
        id: '123',
        expires_at: (
            new Date((new Date().valueOf()) +
                      expireTimeSeconds * 1000)).toISOString()
    };

    var ticketPayload2 = {
        scope: 'test-expire-single-ticket',
        id: '123',
        expires_at: (
            new Date((new Date().valueOf()) +
                      expireTimeSeconds2 * 1000)).toISOString()
    };

    var ticket, ticket2;

    async.waterfall([
        function (wfcb) {
            client.post(wlurl, ticketPayload, function (err, req, res, t) {
                test.deepEqual(err, null);
                test.equal(res.statusCode, 202,
                           'POST waitlist ticket returned 202');
                test.ok(res, 'got a response');
                test.ok(t, 'got an ticket');
                test.ok(t.uuid, 'got a ticket uuid');

                wfcb();
            });
        },
        function (wfcb) {
            client.post(wlurl, ticketPayload2, function (err, req, res, t) {
                test.deepEqual(err, null);
                test.equal(res.statusCode, 202,
                           'POST waitlist ticket returned 202');
                test.ok(res, 'got a response');
                test.ok(t, 'got an ticket');
                test.ok(t.uuid, 'got a ticket uuid');

                wfcb();
            });
        },
        function (wfcb) {
            client.get(wlurl, function (err, req, res, waitlist) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');
                test.ok(waitlist.length);

                ticket = waitlist[0];
                ticket2 = waitlist[1];

                test.deepEqual(ticket.status, 'active');
                test.deepEqual(ticket2.status, 'queued');

                test.ok(ticket);

                wfcb();
            });
        },
        function (wfcb) {
            setTimeout(function () {
                wfcb();
            }, (expireTimeSeconds + 2) * 1000);
        },
        function (wfcb) {
            client.get(wlurl, function (err, req, res, waitlist) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');
                test.ok(waitlist.length);

                ticket = waitlist[0];
                ticket2 = waitlist[1];

                test.ok(ticket);

                wfcb();
            });
        },
        function (wfcb) {
            console.dir(ticket);
            console.dir(ticket2);
            test.deepEqual(ticket.status, 'expired');
            test.deepEqual(ticket2.status, 'active');
            wfcb();
        }
    ],
    function (error) {
        test.equal(error, null);
        test.done();
    });
}

module.exports = {
    setUp: setup,
    tearDown: teardown,
    'expire single ticket': testExpireSingleTicket,
    'create two tickets expire first, start next':
        testExpireSingleTicketStartNext
};
