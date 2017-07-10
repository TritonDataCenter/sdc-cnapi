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


function testWaitForActiveTicket(test) {
    var ticketPayload = {
        scope: 'test-waitlist-wait-test-wait-for-active-ticket',
        id: '111',
        expires_at: (new Date((new Date().valueOf()) + 120*1000)).toISOString()
    };

    var time0;

    async.waterfall([
        function (wfcb) {
            client.post(wlurl, ticketPayload, onpost);

            function onpost(err, req, res, ticket) {
                test.deepEqual(err, null);
                test.equal(res.statusCode, 202,
                           'POST waitlist ticket returned 202');
                test.ok(res, 'got a response');
                test.ok(ticket, 'got an ticket');
                test.ok(ticket.uuid, 'got a ticket uuid');

                ticketuuid = ticket.uuid;
                wfcb();
            }
        },
        function (wfcb) {
            setTimeout(wfcb, 5000);
        },
        function (wfcb) {
            var timeout = setTimeout(function () {
                test.ok(false, 'timed out waiting for active ticket');
            }, 1000);
            time0 = (new Date()).valueOf();
            var geturl = sprintf('/tickets/%s', ticketuuid);
            client.get(geturl, getcb);
            function getcb(err, req, res, ticket) {
                clearTimeout(timeout);
                test.equal(ticket.status, 'active');
                wfcb();
            }
        },
        function (wfcb) {
            var waiturl = sprintf('/tickets/%s/wait', ticketuuid);
            client.get(waiturl, getcb);
            function getcb() {
                test.ok((new Date()).valueOf() - time0 < 1000);
                wfcb();
            }
        }
    ],
    function (error) {
        test.ok(!error, 'there was an error');
        test.done();
    });
}


function testWaitOnTicket(test) {
    var count = 20;
    var payloads = [];
    var i;

    for (i = 0; i < count; i++) {
        payloads.push({
            scope: 'test-waitlist-wait-test-wait-on-ticket',
            id: '111',
            expires_at:
                (new Date((new Date().valueOf()) + 120*1000)).toISOString()
        });
    }

    var ticketUuids = [];

    // create tickets
    //   * check first is 'active'
    //   * check all others are 'queued'

    // for every ticket N, release N, check that ticket N+1 is 'active'

    async.waterfall([
        function (wfcb) {
            async.forEachSeries(payloads, onPayload, onFinish);

            function onPayload(t, fecb) {
                client.post(wlurl, t, function (err, req, res, ticket) {
                    test.deepEqual(err, null);
                    test.equal(res.statusCode, 202,
                               'POST waitlist ticket returned 202');
                    test.ok(res, 'got a response');
                    test.ok(ticket, 'got an ticket');
                    test.ok(ticket.uuid, 'got a ticket uuid');

                    ticketuuid = ticket.uuid;
                    ticketUuids.push(ticket.uuid);
                    fecb();
                });
            }

            function onFinish(err) {
                console.log('ticketUuids');
                console.dir(ticketUuids);
                setTimeout(function () {
                    wfcb();
                }, 5000);
            }
        },
        function (wfcb) {
            // Fetch all the created tickets back
            async.forEachSeries(ticketUuids, onPayload, onFinish);

            var tickets = [];

            function onPayload(t, fecb) {
                var geturl = sprintf('/tickets/%s', t);
                client.get(geturl, getcb);
                function getcb(err, req, res, ticket) {
                    test.equal(err, null, 'error returned');
                    tickets.push(ticket);
                    fecb();
                }
            }

            // Ensure first ticket is 'active', all others are 'queued'
            function onFinish(err) {
                test.equal(tickets[0].status, 'active');
                for (i = 1; i < tickets.length; i++) {
                    test.equal(tickets[i].status, 'queued');
                }
                wfcb();
            }
        },
        function (wfcb) {
            i = 0;

            async.forEachSeries(ticketUuids, onPayload, onFinish);

            function onPayload(t, fecb) {
                console.log('releasing %s', t);
                var puturl = sprintf('/tickets/%s/release', t);
                client.put(puturl, putcb);
                function putcb() {
                    i++;

                    // check next ticket in line
                    if (i === ticketUuids.length) {
                        fecb();
                    } else {
                        setTimeout(function () {
                            console.log('checking %s', ticketUuids[i]);
                            var geturl = sprintf('/tickets/%s', ticketUuids[i]);
                            client.get(geturl, getcb);
                            function getcb(err, req, res, ticket) {
                                test.equal(err, null, 'error returned');
                                test.equal(ticket.status, 'active');
                                fecb();
                            }
                        }, 1000);
                    }
                }
            }

            function onFinish(err) {
                wfcb(err);
            }
        }

//         function (wfcb) {
//             var geturl = sprintf('/tickets/%s', ticketuuid);
//             client.get(geturl, getcb);
//             function getcb(err, req, res, ticket) {
//                 console.log('before wait');
//                 console.dir(ticket);
//                 test.equal(ticket.status, 'active');
//                 wfcb();
//             }
//         },
//         function (wfcb) {
//             waitAndRelease(wfcb);
//         },
//         function (wfcb) {
//             var geturl = sprintf('/tickets/%s', ticketuuid);
//             client.get(geturl, getcb);
//             function getcb(err, req, res, ticket) {
//                 console.dir(ticket);
//                 wfcb();
//             }
//         }
    ],
    function (error) {
        test.ok(!error, 'there was an error');
        test.done();
    });

    function waitAndRelease(cb) {
        async.parallel([
            function (pacb) {
                // wait on ticket
                var waiturl = sprintf('/tickets/%s/wait', ticketuuid);
                console.log('waiting %s', waiturl);
                client.get(waiturl, getcb);
                function getcb() {
                    console.log('done waiting');
                    pacb();
                }
            },
            function (pacb) {
                setTimeout(function () {
                    console.log('releasing');
                    // release ticket
                    var puturl = sprintf('/tickets/%s/release', ticketuuid);
                    client.put(puturl, putcb);
                    function putcb() {
                        console.log('done releasing');
                        pacb();
                    }
                }, 1000);
            }
        ],
        function (error) {
            cb();
        });
    }
}

module.exports = {
    setUp: setup,
    tearDown: teardown,
    'wait on an active': testWaitForActiveTicket,
    'wait on a queued ticket': testWaitOnTicket
};
