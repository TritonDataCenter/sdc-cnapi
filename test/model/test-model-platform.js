/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var async = require('async');
var util = require('util');

var common = require('../../lib/common');
var mock = require('../lib/mock');
var nodeunit = require('nodeunit');

var ModelPlatform = require('../../lib/models/platform');
var ModelServer = require('../../lib/models/server');

function setup(callback) {
    callback();
}

function teardown(callback) {
    callback();
}

var uuids = [
    '372bdb58-f8dd-11e1-8038-0b6dbddc5e58'
];

function testListPlatformsAll(test) {
    var expSearchResults = [
        {
            uuid: uuids[0],
            ram: '12345',
            sysinfo: { 'headnode': true, 'setup': true }
        }
    ];

    var expSearchResults2 = [
        {
            server_uuid: uuids[0]
        }
    ];

    var expUrResult = [
        null,
        '20130521T084103Z\n20150819T020110Z latest\n\n',
        ''
    ];
    mock.newApp(function (error, app, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        var ur = components.ur;

        ModelServer.init(app);
        ModelPlatform.init(app);

        var expGetResults = [
            {
                uuid: uuids[0],
                setup: true, sysinfo: { 'setup': true },
                last_heartbeat: (new Date()).toISOString()
            }
        ];

        moray.client.when('getObject', [], { value: expGetResults[0] });
        moray.client.when('findObjects');
        moray.client.when('getObject', [], { value: expGetResults[0] });

        moray.client._findObjectsResults(expSearchResults);
        moray.client._findObjectsResults(expSearchResults2);

        ur.when('execute', [], expUrResult);

        ModelPlatform.list({}, function (listError, platforms) {
            test.deepEqual(
                platforms,
                { '20130521T084103Z': {},
                  '20150819T020110Z': { latest: true }});
            test.done();
        });
    });
}

function testListPlatformsAllNoLatest(test) {
    var expSearchResults = [
        {
            uuid: uuids[0],
            ram: '12345',
            sysinfo: { 'headnode': true, 'setup': true }
        }
    ];

    var expSearchResults2 = [
        {
            server_uuid: uuids[0], last_heartbeat: (new Date()).toISOString()
        }
    ];


    var expUrResult = [
        null,
        '20130521T084103Z\n20150819T020110Z\n\n',
        ''
    ];
    mock.newApp(function (error, app, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        var ur = components.ur;

        ModelServer.init(app);
        ModelPlatform.init(app);

        var expGetResults = [
            {
                uuid: uuids[0],
                setup: true, sysinfo: { 'setup': true },
                last_heartbeat: (new Date()).toISOString()
            }
        ];

        moray.client.when('getObject', [], { value: expGetResults[0] });
        moray.client.when('findObjects');
        moray.client.when('getObject', [], { value: expGetResults[0] });
        ur.when('execute', [], expUrResult);

        moray.client._findObjectsResults(expSearchResults);
        moray.client._findObjectsResults(expSearchResults2);

        ModelPlatform.list({}, function (listError, platforms) {
            test.deepEqual(
                platforms,
                { '20130521T084103Z': {},
                  '20150819T020110Z': { latest: true }});
            test.done();
        });
    });
}

module.exports = nodeunit.testCase({
    setUp: setup,
    tearDown: teardown,
    'list all platforms': testListPlatformsAll,
    'list all platforms (no latest)': testListPlatformsAllNoLatest
});
