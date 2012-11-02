var async = require('async');
var util = require('util');

var common = require('../lib/common');
var mock = require('./lib/mock');
var nodeunit = require('nodeunit');

var ModelPlatform = require('../lib/models/platform');
var ModelServer = require('../lib/models/server');

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

    var expUrResult = [
        null,
        '12345Z\n4567Z latest\n\n',
        ''
    ];
    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        var ur = components.ur;

        ModelServer.init(model);
        ModelPlatform.init(model);

        moray.when('findObjects');

        ur.when('execute', [], expUrResult);

        ModelPlatform.list({}, function (listError, platforms) {
            test.deepEqual(
                platforms,
                { '12345Z': {}, '4567Z': { latest: true }});
            test.done();
        });

        setTimeout(function () {
            moray._emitResults(expSearchResults);
        }, 100);
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

    var expUrResult = [
        null,
        '12345Z\n4567Z\n\n',
        ''
    ];
    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        var ur = components.ur;

        ModelServer.init(model);
        ModelPlatform.init(model);

        moray.when('findObjects');
        ur.when('execute', [], expUrResult);

        ModelPlatform.list({}, function (listError, platforms) {
            test.deepEqual(
                platforms,
                { '12345Z': {}, '4567Z': {}});
            test.done();
        });

        setTimeout(function () {
            moray._emitResults(expSearchResults);
        }, 100);
    });
}

module.exports = nodeunit.testCase({
    setUp: setup,
    tearDown: teardown,
    'list all platforms': testListPlatformsAll,
    'list all platforms (no latest)': testListPlatformsAllNoLatest
});
