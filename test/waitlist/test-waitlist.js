/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
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
        scope: 'test-create-ticket',
        id: '123',
        expires_at: (new Date((new Date().valueOf()) + 60*1000)).toISOString(),
        action: 'action0',
        extra: { foo: 'bar' }
    };

    var ticketPayload2 = {
        scope: 'test-create-ticket',
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
        scope: 'test-create-wait-release-ticket',
        id: '123',
        expires_at: (
            new Date((new Date().valueOf()) +
                      expireTimeSeconds * 1000)).toISOString()
    };

    var ticketPayload2 = {
        scope: 'test-create-wait-release-ticket',
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


/**
 * Try listing tickets using legal and bogus `limit` and `offset` values.
 */

function testLimitOffsetValidation(test) {
    test.expect(36);
    var count = 5;

    var badopts = [
        'limit=-1',
        'offset=-1',
        'limit=pizzacake',
        'limit=1up',
        'limit=bad1',
        'limit=0'
    ];

    var goodopts = [
        'limit=1',
        'offset=1',
        'offset=0'
    ];

    async.waterfall([
        // Create number of tickets given by `count`
        function (wfcb) {
            createTickets({
                ticketsScope: 'limit-offset-validation',
                test: test,
                count: count
            }, function (err, tickets) {
                if (err) {
                    wfcb(err);
                    return;
                }

                wfcb();
            });
        },
        function (wfcb) {
            async.forEach(
                badopts,
                function (q, fecb) {
                    var geturl = sprintf(
                        '/servers/%s/tickets?%s', serveruuid, q);
                    client.get(geturl, getcb);
                    function getcb(err, req, res, results) {
                        test.ok(err, 'should have gotten an error');
                        fecb();
                    }
                },
                function (err) {
                    wfcb(err);
                });
        },
        function (wfcb) {
            async.forEach(
                goodopts,
                function (q, fecb) {
                    var geturl = sprintf(
                        '/servers/%s/tickets?%s', serveruuid, q);
                    client.get(geturl, getcb);
                    function getcb(err, req, res, results) {
                        test.ok(!err, 'should not have gotten an error');
                        fecb();
                    }
                },
                function (err) {
                    wfcb(err);
                });
        }
    ],
    function (err) {
        test.ok(!err, 'no errors returned');
        test.done();
    });
}


/**
 * Confirm we can page through the waitlist tickets for a compute node when
 * there are greater than 1000 tickets (the default moray limit). Exercises
 * `limit` and `offset` parameters.
 */

function testFetchTicketsWithPaging(test) {
    test.expect(638);

    var count = 100;
    var limit = 10;
    var offset = 0;

    var ticketUuids;

    async.waterfall([
        // Create number of tickets given by `count`
        function (wfcb) {
            createTickets({
                ticketsScope: 'fetch-tickets-with-paging',
                test: test,
                count: count
            }, function (err, tickets) {
                if (err) {
                    wfcb(err);
                    return;
                }
                ticketUuids = tickets;
                test.ok(Object.keys(ticketUuids).length >= count,
                    'server at least has many tickets as were added');
                wfcb();
            });
        },

        // Page through in amounts given by `limit`, tally them and check that
        // the UUIDs are the ones we created.
        function (wfcb) {
            var fetchMore = true;

            var listOfResults = [];
            var tickets = [];

            async.whilst(
                function () {
                    return fetchMore;
                },
                doFetch,
                function (err) {
                    test.ok(listOfResults.length,
                            'should be multiple pages of results (there were '
                            + listOfResults.length + ')');

                    for (var ri in listOfResults) {
                        var result = listOfResults[ri];
                        if (ri < listOfResults.length-1) {
                            test.equal(listOfResults[ri].length, limit,
                                'each page has right number of results');
                        } else {
                            test.equal(
                               listOfResults[ri].length,
                               count % limit,
                               'last page should have `count % limit`' +
                               ' number of results');
                        }

                        // Ensure ticket is one of the ones we created
                        for (var r in result) {
                            var ticket = result[r];
                            test.ok(ticketUuids[ticket.uuid],
                                    'found ticket we created');
                        }
                    }

                    test.equal(listOfResults.length, 1+count/limit,
                               'right number of pages');
                    wfcb(err);
                });

            // Fetch all the created tickets
            function doFetch(wlcb) {
                var geturl = sprintf(
                    '/servers/%s/tickets?limit=%d&offset=%d',
                    serveruuid, limit, offset);
                client.get(geturl, getcb);
                function getcb(err, req, res, results) {
                    test.ok(Array.isArray(results), 'result is an array');
                    test.ok(results.length <= limit,
                            'result length <= `limit`');

                    listOfResults.push(results);
                    Array.prototype.push.apply(tickets, results);


                    // Check if we have reached the end of the results
                    if (results.length < limit) {
                        fetchMore = false;
                    }
                    offset += limit;
                    wlcb();
                }
            }
        }
    ],
    function (error) {
        test.ok(!error, 'no errors returned');
        test.done();
    });
}


/**
 *
 * Create over 1000 tickets (the default moray limit) and make sure we
 * can hit the delete ticket endpoint and all tickets are removed.
 *
 */

function testDeleteOver1000Tickets(test) {
    test.expect(5506);
    var count = 1100;

    async.waterfall([
        function (wfcb) {
            createTickets({
                ticketsScope: 'delete-over-1000-tickets',
                test: test,
                count: count
            }, function (err, tickets) {
                if (err) {
                    wfcb(err);
                    return;
                }
                wfcb();
            });
        },
        function (wfcb) {
            // Fetch all the created tickets back
            var geturl = sprintf('/servers/%s/tickets', serveruuid);
            client.get(geturl, getcb);
            function getcb(err, req, res, results) {
                test.ok(Array.isArray(results), 'result is an array');
                test.notEqual(results.length, 0,
                    'result array not empty, nb tickets is: ' + results.length);
                wfcb();
            }

        },
        function (wfcb) {
            var delurl = sprintf('/servers/%s/tickets?force=true', serveruuid);
            client.del(delurl, delcb);
            function delcb(err, req, res, results) {
                test.equal(err, null, 'no error returned');
                wfcb();
            }
        },
        function (wfcb) {
            // Fetch all the created tickets back
            var geturl = sprintf('/servers/%s/tickets', serveruuid);
            client.get(geturl, getcb);
            function getcb(err, req, res, results) {
                test.ok(Array.isArray(results), 'result is an array');
                test.equal(results.length, 0,
                            'result length is 0 (was ' +
                                results.length + ', content: ' +
                                util.inspect(results) + ')');
                wfcb();
            }

        }
    ], function (err) {
        console.log((new Date().toISOString() + 'calling test.done()'));
        test.done();
        console.log((new Date().toISOString() + 'called test.done()'));
    });
}


/**
 *
 * Support functions
 *
 */

function createTickets(opts, callback) {
    assert.object(opts, 'opts');
    assert.number(opts.count, 'opts.count');
    assert.string(opts.ticketsScope, 'opts.ticketsScope');
    assert.object(opts.test, 'opts.test');

    var ticketUuids = {};

    var count = opts.count;
    var test = opts.test;

    async.waterfall([
        // Create N tickets
        function (wfcb) {
            var num = 0;
            var i;

            // Set up payloads
            var payloads = [];
            for (i = 0; i < count; i++) {
                payloads.push({
                    scope: opts.ticketsScope,
                    /*
                     * This ID needs to be constant so tickets get queued and
                     * don't become active.
                     */
                    id: '111',
                    expires_at:
                        (new Date((new Date().valueOf()) +
                         i*1000 + 600*1000)).toISOString()
                });
            }

            // Fire off create requests
            async.forEachSeries(payloads, onPayload, onFinish);
            function onPayload(t, fecb) {
                client.post(wlurl, t, function (err, req, res, ticket) {
                    test.deepEqual(err, null, 'no error returned');
                    test.equal(res.statusCode, 202,
                               'POST waitlist ticket returned 202');
                    test.ok(res, 'http response');
                    test.ok(ticket, 'ticket created');
                    test.ok(ticket.uuid, 'ticket had a UUID');

                    ticketuuid = ticket.uuid;
                    ticketUuids[ticket.uuid] = true;

                    console.log('created %s (#%d)', ticketuuid, num++);
                    fecb();
                });
            }

            function onFinish(err) {
                wfcb(err);
            }
        }
    ], function (err) {
        test.equal(err, null, 'no error returned');
        callback(err, ticketUuids);
    });
}




module.exports = {
    setUp: setup,
    tearDown: teardown,
    'delete all tickets': testDeleteAllWaitlistTickets,
    'create tickets then get one or many': testCreateTicket,
    'limit, offset parameter validation': testLimitOffsetValidation,
    'list from server with paging': testFetchTicketsWithPaging,
    'delete from server with over 1000 results':
        testDeleteOver1000Tickets
};
