var async = require('async');
var util = require('util');

var common = require('../lib/common');
var mock = require('./lib/mock');
var nodeunit = require('nodeunit');

var ModelPlatform = require('../lib/models/platform');

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
        null,
        [
            {
                uuid: uuids[0],
                ram: '12345',
                sysinfo: '{ "headnode": true, "setup": true }'
            }
        ]
    ];

    var expUrResult = [
        null,
        '12345Z\n4567Z latest\n\n',
        ''
    ];
    mock.newModel(function (error, model, mockUfds, mockUr) {
        ModelPlatform.init(model);
        mockUfds.when('search', [], expSearchResults);
        mockUr.when('execute', [], expUrResult);

        ModelPlatform.list({}, function (listError, platforms) {
            test.deepEqual(
                platforms,
                { '12345Z': {}, '4567Z': { latest: true }});
            test.done();
        });
    });
}

function testListPlatformsAllNoLatest(test) {
    var expSearchResults = [
        null,
        [
            {
                uuid: uuids[0],
                ram: '12345',
                sysinfo: '{ "headnode": true, "setup": true }'
            }
        ]
    ];

    var expUrResult = [
        null,
        '12345Z\n4567Z\n\n',
        ''
    ];
    mock.newModel(function (error, model, mockUfds, mockUr) {
        ModelPlatform.init(model);
        mockUfds.when('search', [], expSearchResults);
        mockUr.when('execute', [], expUrResult);

        ModelPlatform.list({}, function (listError, platforms) {
            test.deepEqual(
                platforms,
                { '12345Z': {}, '4567Z': {}});
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
