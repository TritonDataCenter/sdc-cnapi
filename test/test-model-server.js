var async = require('async');
var util = require('util');

var common = require('../lib/common');
var mock = require('./lib/mock');
var nodeunit = require('nodeunit');

var ModelServer = require('../lib/models/server');

var uuids = [
    '372bdb58-f8dd-11e1-8038-0b6dbddc5e58',
    '6e8eb888-f8e0-11e1-b1a8-5f74056f9365',
    'b31695ce-f8e6-11e1-b252-fb742866284b'
];


function setup(callback) {
    callback();
}

function teardown(callback) {
    callback();
}

function testListServersAll(test) {
    test.expect(4);

    var expSearchResults = [
        null,
        [ { uuid: uuids[0], ram: '12345', sysinfo: '{ "setup": true }' },
          { uuid: uuids[1], ram: '56789', sysinfo: '{ "setup": true }' }
        ]
    ];

    mock.newModel(function (error, model, mockUfds) {
        test.equal(error, null, 'should not encounter an error');
        mockUfds.when('search', [], expSearchResults);

        ModelServer.init(model);

        var options = {};

        ModelServer.list(options, function (listError, servers) {
            test.equal(listError, null, 'should not encounter an error');
            test.deepEqual(
                mockUfds.history[0],
                [ 'search',
                  'ou=servers, datacenter=testdc, o=smartdc',
                  { 'scope':'sub', 'filter': '(&(objectclass=server)(uuid=*))' }
                ],
                'ufds client parameters');

            test.deepEqual(
                servers,
                expSearchResults[1],
                'Server results should match');
            test.done();
        });
    });
}

function testListServersByUuids(test) {
    test.expect(5);

    var expSearchResults = [
        null,
        [ { uuid: uuids[0], ram: '12345', sysinfo: '{ "setup": true }' },
          { uuid: uuids[1], ram: '56789', sysinfo: '{ "setup": true }' }
        ]
    ];

    mock.newModel(function (error, model, mockUfds) {
        test.equal(error, null, 'should not encounter an error');

        ModelServer.init(model);

        mockUfds.when('search', [], expSearchResults);

        var options = {
            uuid: [uuids[0], uuids[2]]
        };

        ModelServer.list(options, function (listError, servers) {
            test.equal(listError, null, 'should not encounter an error');

            test.equal(
                servers.length, 2, 'correct number of results returned');

            test.deepEqual(
                mockUfds.history[0],
                [ 'search',
                  'ou=servers, datacenter=testdc, o=smartdc',
                  { 'scope':'sub',
                    'filter':
                    '(&(objectclass=server)'
                    + '(|(uuid=' + uuids[0] + ')(uuid=' + uuids[2] + ')))' }
                ],
                'ufds client parameters');

            test.deepEqual(
                servers,
                expSearchResults[1],
                'Server results should match');

            test.done();
        });
    });
}

function testListServersSetup(test) {
    test.expect(3);

    var expSearchResults = [
        null,
        [ { uuid: uuids[0], setup: 'true', sysinfo: '{ "setup": true }' },
          { uuid: uuids[1], setup: 'true', sysinfo: '{ "setup": true }' }
        ]
    ];

    mock.newModel(function (error, model, mockUfds) {
        test.equal(error, null, 'should not encounter an error');
        mockUfds.when('search', [], expSearchResults);
        ModelServer.init(model);

        var options = {
            setup: 'true'
        };

        ModelServer.list(options, function (listError, servers) {
            test.equal(listError, null, 'should not encounter an error');

            test.deepEqual(
                mockUfds.history[0],
                [ 'search',
                  'ou=servers, datacenter=testdc, o=smartdc',
                  { 'scope':'sub',
                    'filter':
                    '(&(objectclass=server)'
                    + '(uuid=*)(setup=true))' }
                ],
                'ufds client parameters');
            test.done();
        });
    });
}

function testCreateServer(test) {
    test.expect(3);

    var dn = 'uuid=' + uuids[0] + ',ou=servers, datacenter=testdc, o=smartdc';
    var serverToAdd = {
        uuid: uuids[0],
        ram: '12345'
    };

    var server = new ModelServer(uuids[0]);

    mock.newModel(function (error, model, mockUfds) {
        test.equal(error, null, 'should not encounter an error');

        mockUfds.when('add', []);
        ModelServer.init(model);

        server.addServerToUfds(serverToAdd, function (listError) {
            test.equal(listError, null, 'should not encounter an error');
            test.deepEqual(
                [
                    [ 'add',
                      dn,
                      serverToAdd
                    ]
                ],
                mockUfds.history,
                'ufds command history');
            test.done();
        });
    });
}

function testModifyServer(test) {
    test.expect(6);

    var uuid = uuids[0];
    var dn = 'uuid=' + uuid + ',ou=servers, datacenter=testdc, o=smartdc';

    var server = new ModelServer(uuids[0]);

    mock.newModel(function (error, model, mockUfds) {
        test.equal(error, null, 'should not encounter an error');

        mockUfds.when('add', []);

        var bootPlatform = '123Z';
        var changes = [
            {
                type: 'replace',
                modification: {
                    boot_platform: bootPlatform
                }
            }
        ];
        ModelServer.init(model);

        mockUfds.when('replace', []);

        server.modify(changes, function (modifyError) {
            test.equal(modifyError, null, 'should not encounter an error');
            test.deepEqual(
                'replace',
                mockUfds.history[0][0],
                'op should be replace');
            test.deepEqual(dn, mockUfds.history[0][1], 'dn should match');
            test.deepEqual(
                bootPlatform,
                mockUfds.history[0][2][0].modification.boot_platform,
                'boot platform should match');
            test.ok(
                bootPlatform,
                mockUfds.history[0][2][1].modification.last_updated,
                'last_platform date should be set');

            test.done();
        });
    });
}

module.exports = nodeunit.testCase({
    setUp: setup,
    tearDown: teardown,
    'list all servers':                       testListServersAll,
    'list multiple servers by uuid':          testListServersByUuids,
    'list servers which are marked as setup': testListServersSetup,
    'create server':                          testCreateServer,
    'modify server':                          testModifyServer
});
