/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Test that non-existent routes do not crash CNAPI.
 */

var restify = require('restify');
var vasync = require('vasync');

var HTTP_OK = 200;
var HTTP_MISSING = 404;

var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var client;

function setup(callback) {
    client = restify.createJsonClient({
        agent: false,
        url: CNAPI_URL
    });
    callback();
}


function teardown(callback) {
    callback();
}


function testNonExistentRoute(test) {
    var expected = 9;
    var startTimestamp;

    test.expect(expected);

    vasync.waterfall([
        function _getDiagnostics(next) {
            client.get('/diagnostics', _onGet);

            function _onGet(err, req, res, diagnostics) {
                test.ifError(err);
                test.equal(res.statusCode, HTTP_OK,
                        'GET /diagnostics returned 200');
                test.ok(diagnostics.start_timestamp, 'got a date');

                startTimestamp = diagnostics.start_timestamp;
                next();
            }
        },
        function _hitBadRoute(next) {
            client.get('/doesnotexist', _onGet);
            function _onGet(err, _req, _res, _diagnostics) {
                test.ok(err, 'should get an error');
                test.equal(err.statusCode, HTTP_MISSING,
                    'error should be a 404');
                next();
            }
        },
        function _checkStartTimestampValue(next) {
            client.get('/diagnostics', _onGet);

            function _onGet(err, req, res, diagnostics) {
                test.ifError(err);
                test.equal(res.statusCode, HTTP_OK,
                        'GET /diagnostics returned 200');
                test.equal(diagnostics.start_timestamp, startTimestamp,
                        'start timestamp has not changed');

                startTimestamp = diagnostics.start_timestamp;
                next();
            }
        }
    ], function _finish(err) {
        test.ifError(err, 'no errors');
        test.done();
    });
}


module.exports = {
    setUp: setup,
    tearDown: teardown,
    'test-non-existent-route': testNonExistentRoute
};
