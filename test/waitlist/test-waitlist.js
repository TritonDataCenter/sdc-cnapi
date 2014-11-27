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
var util = require('util');
var path = require('path');
var uuid = require('node-uuid');
var sprintf = require('sprintf').sprintf;

var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var client;

var wlurl;
var serveruuid;

var ticketuuid;

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


function testDeleteAllWaitlistTickets(test) {
    test.expect(6);

    async.waterfall([
        function (wfcb) {
            client.get(wlurl, function (err, req, res, waitlist) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');
                test.ok(waitlist);
                test.deepEqual(waitlist, []);
                wfcb();
            });
        }
    ],
    function (error) {
        test.ok(!error);
        test.done();
    });
}


function testCreateTicket(test) {
    test.expect(59);

    var ticketPayload = {
        scope: 'test',
        id: '123',
        expires_at: (new Date((new Date().valueOf()) + 60*1000)).toISOString(),
        action: 'action0',
        extra: { foo: 'bar' }
    };

    var ticketPayload2 = {
        scope: 'test',
        id: '234',
        expires_at: (new Date((new Date().valueOf()) + 60*1000)).toISOString(),
        action: 'action1',
        extra: { foo: 'baz' }
    };

    var ticketPayloads = [
        ticketPayload,
        ticketPayload,
        ticketPayload2
    ];

    var ticketuuids = [];

    async.waterfall([
        function (wfcb) {
            var queues = [];
            // Create the tickets from payload given in ticketPayloads
            async.forEachSeries(ticketPayloads, onTicketPayload, onForEachEnd);

            function onTicketPayload(tp, fecb) {
                client.post(wlurl, tp, function (err, req, res, ticket) {
                    test.deepEqual(err, null);
                    test.equal(res.statusCode, 202,
                               'POST waitlist ticket returned 202');
                    test.ok(res, 'got a response');
                    test.ok(ticket, 'got an ticket');
                    test.ok(ticket.uuid, 'got a ticket uuid');

                    ticketuuids.push(ticket.uuid);
                    ticketuuid = ticket.uuid;
                    queues.push(ticket.queue);
                    fecb();
                });
            }

            function onForEachEnd(err) {
                test.equal(queues[0].length, 1);
                test.equal(queues[1].length, 2);
                test.equal(queues[0].length, 1);

                test.equal(queues[0][0].action, 'action0');
                test.equal(queues[1][0].action, 'action0');
                test.equal(queues[1][1].action, 'action0');
                test.equal(queues[2][0].action, 'action1');

                console.error(util.inspect(queues));
                wfcb();
            }
        },
        function (wfcb) {
            // Test getting a single waitlist ticket
            var ticketurl = sprintf('/tickets/%s', ticketuuid);
            client.get(ticketurl, getcb);

            function getcb(err, req, res, ticket) {
                test.deepEqual(err, null);
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200,
                    'GET waitlist ticket returned 200');

                test.ok(ticket);
                test.equal(ticket.scope, ticketPayload2.scope);
                test.equal(ticket.server_uuid, serveruuid);
                test.equal(ticket.expires_at, ticketPayload2.expires_at);
                test.equal(ticket.server_uuid, serveruuid);
                test.equal(ticket.id, ticketPayload2.id);
                test.deepEqual(ticket.extra, ticketPayload2.extra);

                wfcb();
            }
        },
        function (wfcb) {
            setTimeout(function () {
                wfcb();
            }, 2000);
        },
        function (wfcb) {
            // Test listing all waitlist tickets on a server
            client.get(wlurl, function (err, req, res, waitlist) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');

                test.ok(waitlist);
                test.equal(waitlist.length, 3);

                test.equal(waitlist[0].scope, ticketPayload.scope);
                test.equal(waitlist[0].server_uuid, serveruuid);
                test.equal(waitlist[0].expires_at, ticketPayload.expires_at);
                test.equal(waitlist[0].server_uuid, serveruuid);
                test.equal(waitlist[0].id, ticketPayload.id);
                test.deepEqual(waitlist[0].extra, ticketPayload.extra);
                test.equal(waitlist[0].status, 'active');

                test.equal(waitlist[1].scope, ticketPayload.scope);
                test.equal(waitlist[1].server_uuid, serveruuid);
                test.equal(waitlist[1].expires_at, ticketPayload.expires_at);
                test.equal(waitlist[1].server_uuid, serveruuid);
                test.equal(waitlist[1].id, ticketPayload.id);
                test.deepEqual(waitlist[1].extra, ticketPayload.extra);
                test.equal(waitlist[1].status, 'queued');

                test.equal(waitlist[2].scope, ticketPayload2.scope);
                test.equal(waitlist[2].server_uuid, serveruuid);
                test.equal(waitlist[2].expires_at, ticketPayload2.expires_at);
                test.equal(waitlist[2].server_uuid, serveruuid);
                test.equal(waitlist[2].id, ticketPayload2.id);
                test.deepEqual(waitlist[2].extra, ticketPayload2.extra);
                test.equal(waitlist[2].status, 'active');

                wfcb();
            });
        }
    ],
    function (error) {
        test.equal(error, null, 'No errors received');
        test.done();
    });
}


function testCreateWaitReleaseTicket(test) {
    var expireTimeSeconds = 3;
    var expireTimeSeconds2 = 4;
    var ticketPayload = {
        scope: 'test',
        id: '123',
        expires_at: (
            new Date((new Date().valueOf()) +
                      expireTimeSeconds * 1000)).toISOString()
    };

    var ticketPayload2 = {
        scope: 'test',
        id: '123',
        expires_at: (
            new Date((new Date().valueOf()) +
                      expireTimeSeconds2 * 1000)).toISOString()
    };

    var ticket;
    var ticket2;

    async.waterfall([
        function (wfcb) {
            client.post(wlurl, ticketPayload, function (err, req, res, t) {
                test.deepEqual(err, null);
                test.equal(
                    res.statusCode, 202, 'POST waitlist ticket returned 202');
                test.ok(res, 'got a response');
                test.ok(t, 'got an ticket');
                test.ok(t.uuid, 'got a ticket uuid');

                wfcb();
            });
        },
        function (wfcb) {
            client.post(wlurl, ticketPayload2, function (err, req, res, t) {
                test.deepEqual(err, null);
                test.equal(
                    res.statusCode, 202, 'POST waitlist ticket returned 202');
                test.ok(res, 'got a response');
                test.ok(t, 'got an ticket');
                test.ok(t.uuid, 'got a ticket uuid');

                wfcb();
            });
        },
        function (wfcb) {
            setTimeout(function () {
                wfcb();
            }, 1000);
        },
        function (wfcb) {
            client.get(wlurl, function (err, req, res, waitlist) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');
                test.ok(waitlist.length);

                ticket = waitlist[1];
                ticket2 = waitlist[2];

                test.deepEqual(ticket.status, 'active');
                test.deepEqual(ticket2.status, 'queued');

                test.ok(ticket);

                wfcb();
            });
        },
        function (wfcb) {
            setTimeout(function () {
                wfcb();
            }, expireTimeSeconds2 * 1000);
        },
        function (wfcb) {
            client.get(wlurl, function (err, req, res, waitlist) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');
                test.ok(waitlist.length);

                ticket = waitlist[1];
                ticket2 = waitlist[2];
                test.ok(ticket);

                wfcb();
            });
        },
        function (wfcb) {
            test.deepEqual(ticket.status, 'expired');
//             test.deepEqual(ticket2.status, 'active');
            wfcb();
        }
    ],
    function (error) {
        test.equal(error, null);
        test.done();
    });
}

function testUpdateTicket(test) {
    test.expect(4);

//     var date;
    var ticketurl = sprintf('%s/%s', wlurl, ticketuuid);

    async.waterfall([
        function (wfcb) {
            client.get(ticketurl, function (err, req, res, ticket) {
                test.equal(err, null, 'valid response from GET /servers');
                test.ok(res, 'got a response');
                test.equal(res.statusCode, 200, 'GET waitlist returned 200');
                test.ok(ticket);
                wfcb();
            });
        },
        function (wfcb) {
//             client.post(ticketurl, function (err, req, res, ticket) {
//                 test.equal(err, null, 'valid response from GET /servers');
//                 test.ok(res, 'got a response');
//                 test.equal(res.statusCode, 200, 'GET waitlist returned 200');
//                 test.ok(waitlist);
//                 date = wa
//                 test.done();
//             });
            wfcb();
        },
        function (wfcb) {
            wfcb();
        }
    ],
    function (error) {
        test.done();
    });
}



module.exports = {
    setUp: setup,
    tearDown: teardown,
    'delete all tickets': testDeleteAllWaitlistTickets,
    'create tickets then get one or many': testCreateTicket
//     'waiting on a ticket': testWaitOnTicket
//    'create ticket and update status': testUpdateTicket
};
