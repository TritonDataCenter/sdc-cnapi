var async = require('async');
var util = require('util');

var common = require('../lib/common');
var mock = require('./lib/mock');
var nodeunit = require('nodeunit');
var sprintf = require('sprintf').sprintf;

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
        { uuid: uuids[0], ram: '12345', sysinfo: { 'setup': true } },
        { uuid: uuids[1], ram: '56789', sysinfo: { 'setup': true } }
    ];

    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;

        moray.client.when('findObjects');

        ModelServer.init(model);

        var options = {};

        ModelServer.list(options, function (listError, servers) {
            test.equal(listError, null, 'should not encounter an error');
            var expected =  [
                {
                    uuid: '372bdb58-f8dd-11e1-8038-0b6dbddc5e58',
                    ram: '12345',
                    sysinfo: { setup: true }
                },
                {
                    uuid: '6e8eb888-f8e0-11e1-b1a8-5f74056f9365',
                    ram: '56789',
                    sysinfo: { setup: true }
                }
            ];

            test.deepEqual(servers, expected, 'list results should match');
            test.deepEqual(
                moray.client.history[0],
                [
                    'findObjects',
                    'cnapi_servers',
                    '(&(uuid=*)!(uuid=default))',
                    { sort: { attribute: 'uuid', order: 'ASC' } }
                ],
                'moray history should match');
            test.done();
        });

        moray.client._emitResults(expSearchResults);
    });
}

function testListServersByUuids(test) {
    test.expect(4);

    var expSearchResults = [
        { uuid: uuids[0], ram: '12345', sysinfo: { 'setup': true } },
        { uuid: uuids[2], ram: '56789', sysinfo: { 'setup': true } }
    ];

    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        moray.client.when('findObjects');

        ModelServer.init(model);

        var options = {
            uuid: [uuids[0], uuids[2]]
        };

        ModelServer.list(options, function (listError, servers) {
            test.equal(listError, null, 'should not encounter an error');

            var expected =  [
                {
                    uuid: '372bdb58-f8dd-11e1-8038-0b6dbddc5e58',
                    ram: '12345',
                    sysinfo: { setup: true }
                },
                {
                    uuid: 'b31695ce-f8e6-11e1-b252-fb742866284b',
                    ram: '56789',
                    sysinfo: { setup: true }
                }
            ];

           test.deepEqual(
               servers,
               expected,
               'Server results should match');

            var filter
                = expSearchResults
                    .sort(function (a, b) {
                        return a.uuid > b.uuid;
                    })
                    .map(function (i) {
                        return sprintf('(uuid=%s)', i.uuid);
                    })
                    .join('');

            filter = sprintf('(&(|%s)!(uuid=default))', filter);

            test.deepEqual(
                moray.client.history[0],
                [
                    'findObjects',
                    'cnapi_servers',
                    filter,
                    { sort: { attribute: 'uuid', order: 'ASC' } }
                ],
                'moray history should match');


            test.done();
        });

        moray.client._emitResults(expSearchResults);
    });
}

function testListServersSetup(test) {
    test.expect(4);

    var expSearchResults = [
        { uuid: uuids[0], ram: '12345', sysinfo: { 'setup': true } },
        { uuid: uuids[1], ram: '56789', sysinfo: { 'setup': true } }
    ];

    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;

        moray.client.when('findObjects');

        ModelServer.init(model);

        var options = {
            setup: true
        };

        ModelServer.list(options, function (listError, servers) {
            test.equal(listError, null, 'should not encounter an error');

            var expected =  [
                {
                    uuid: '372bdb58-f8dd-11e1-8038-0b6dbddc5e58',
                    ram: '12345',
                    sysinfo: { setup: true }
                },
                {
                    uuid: '6e8eb888-f8e0-11e1-b1a8-5f74056f9365',
                    ram: '56789',
                    sysinfo: { setup: true }
                }
            ];

            test.deepEqual(servers, expected, 'list results should match');

            test.deepEqual(
                moray.client.history[0],
                [
                    'findObjects',
                    'cnapi_servers',
                    '(&(uuid=*)(&(setup=true)!(uuid=default)))',
                    { sort: { attribute: 'uuid', order: 'ASC' } }
                ],
                'moray history should match');
            test.done();
        });

        moray.client._emitResults(expSearchResults);
    });
}

function testFetchServer(test) {
    test.expect(4);

    var expSearchResults = [
        { uuid: uuids[0], setup: true, sysinfo: { 'setup': true } }
    ];

    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        moray.client.when('getObject', [], { value: expSearchResults[0] });

        ModelServer.init(model);

        var server = new ModelServer(uuids[0]);

        server.getRaw(function (getError, s) {
            test.equal(getError, null, 'should not encounter an error');
            test.deepEqual(s, expSearchResults[0], 'results should match');
            test.deepEqual(
                moray.client.history[0],
                [
                    'getObject',
                    'cnapi_servers',
                    uuids[0]
                ],
                'moray history should match');
            test.done();
        });
    });
}

function testCreateServer(test) {
    test.expect(3);

    var serverToAdd = { uuid: uuids[0], ram: '12345' };

    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        moray.client.when('putObject', []);
        ModelServer.init(model);

        var server = new ModelServer(uuids[0]);
        server.setRaw(serverToAdd);
        server.store(serverToAdd, function (storeError) {
            test.equal(storeError, null, 'should not encounter an error');
            test.deepEqual(
                moray.client.history[0],
                [
                    'putObject',
                    'cnapi_servers',
                    uuids[0],
                    serverToAdd
                ],
            'moray command history');
            test.done();
        });
    });
}

function testDeleteServer(test) {
    test.expect(3);

    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');
        ModelServer.init(model);
        var redis = components.redis;

        var server = new ModelServer(uuids[0]);

        redis.client.when(
            'keys',
            [],
            [
                null,
                [
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58',
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58:vms',
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58:memory',
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58:status'
                ]
            ]);
        server.del(function (delError) {
            test.equal(delError, null, 'should not encounter an error');

            test.deepEqual(
                redis.client.history,
                [ [ 'keys',
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58*'
                  ],
                  [ 'del',
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58'
                  ],
                  [ 'del',
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58:vms'
                  ],
                  [ 'del',
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58:memory'
                  ],
                  [ 'del',
                    'cnapi:servers:372bdb58-f8dd-11e1-8038-0b6dbddc5e58:status'
                  ]
                ], 'redis history');
            test.done();
        });
    });
}

function testRebootServer(test) {
    test.expect(2);

    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        var workflow = components.workflow;

        var expSearchResults = [
            { uuid: uuids[0], setup: true, sysinfo: { 'setup': true } }
        ];

        moray.client.when('getObject', [], { value: expSearchResults[0] });

        moray.client.when('putObject', []);

        ModelServer.init(model);

        moray.client.when('findObjects');

        var server = new ModelServer(uuids[0]);

        server.reboot(function (err) {
            test.deepEqual(
                workflow.getClient().history,
                [
                    [
                        'createJob',
                        'server-reboot',
                        {
                            cnapi_url: 'http://10.99.99.18',
                            server_uuid: '372bdb58-f8dd-11e1-8038-0b6dbddc5e58',
                            target: '372bdb58-f8dd-11e1-8038-0b6dbddc5e58'
                        }
                    ]
                ]);
            test.done();
        });
    });
}

function testModifyServer(test) {
    test.expect(3);

    var uuid = uuids[0];

    mock.newModel(function (error, model, components) {
        test.equal(error, null, 'should not encounter an error');

        var moray = components.moray;
        moray.client.when('putObject', []);

        ModelServer.init(model);

        var server = new ModelServer(uuids[0]);

        var change = {
            uuid: uuid,
            setup: false
        };

        server.modify(change, function (modifyError) {
            test.deepEqual(
                moray.client.history[0],
                [
                    'putObject',
                    'cnapi_servers',
                    uuid,
                    change
                ],
            'moray command history');

            test.deepEqual(
                moray.client.history[0][3].setup,
                false,
                'boot platform should match');
            test.done();
        });
    });
}

function testSetBootParameters(test) {
    test.expect(5);

    var uuid = uuids[0];

    var server;
    var moray;
    var redis;

    var newBootParameters = {
        simple: 'ronny',
        equal_quotes: 'sauce="apple"',
        commas: 'fee,fi,fo,fum',
        backslash: 'fruit\\cake'
    };

    var expSearchResults = {
        uuid: uuid,
        boot_params: {},
        setup: true,
        boot_platform: '123Z',
        hostname: 'testbox',
        sysinfo: { 'setup': true },
        default_console: 'serial',
        serial: 'ttyb',
        serial_speed: 100
    };

    async.waterfall([
        function (callback) {
            mock.newModel(function (error, model, components) {
                moray = components.moray;
                redis = components.redis;

                test.equal(error, null, 'should not encounter an error');

                moray.client.when('putObject', []);
                moray.client.when('getObject', [], { value: expSearchResults });

                ModelServer.init(model);

                server = new ModelServer(uuid);
                callback();
            });
        },
        function (callback) {
            server.setBootParams(
                {
                    boot_params: newBootParameters,
                    boot_platform: 'newer',
                    default_console: 'vga',
                    serial: 'ttya',
                    serial_speed: 200
                },
                function (modifyError) {
                    test.equal(
                        modifyError,
                        null,
                        'There should be no error');

                    test.deepEqual(
                        moray.client.history[1],
                        [
                            'putObject',
                            'cnapi_servers',
                            uuid,
                            {
                                uuid: uuid,
                                boot_params: newBootParameters,
                                setup: true,
                                boot_platform: 'newer',
                                hostname: 'testbox',
                                sysinfo: { 'setup': true },
                                default_console: 'vga',
                                serial: 'ttya',
                                serial_speed: 200
                            }
                        ],
                        'moray command history');
                        callback();
                });
        },
        function (callback) {
            expSearchResults = {
                uuid: uuid,
                boot_params: newBootParameters,
                setup: true,
                boot_platform: 'newer',
                hostname: 'testbox',
                sysinfo: { 'setup': true },
                default_console: 'serial',
                serial: 'ttyb',
                serial_speed: 100
            };

            moray.client.when('getObject', [], { value: expSearchResults });
            delete server.value;
            redis.client.when('hgetall', [], {});

            server.getBootParams(function (getError, params) {
                test.equal(
                     getError,
                     null,
                'There should be no error');

                test.deepEqual(
                    params,
                    {
                        platform: 'newer',
                        kernel_args: {
                            rabbitmq: 'guest:guest:localhost:5672',
                            hostname: 'testbox',
                            simple: 'ronny',
                            equal_quotes: 'sauce="apple"',
                            commas: 'fee,fi,fo,fum',
                            backslash: 'fruit\\cake'
                        },
                        default_console: 'serial',
                        serial: 'ttyb',
                        serial_speed: 100
                    });

                callback();
            });
        }
    ],
    function () {
        test.done();
    });
}

function testUpdateBootParameters(test) {
    test.expect(5);

    var uuid = uuids[0];

    var server;
    var moray;
    var redis;

    var update = {
        updated: 'shazbot'
    };

    var updatedBootParams = {
        original: 'value',
        updated: 'shazbot'
    };

    var expSearchResults = {
        uuid: uuid,
        boot_params: { 'original': 'value' },
        setup: true,
        boot_platform: '123Z',
        hostname: 'testbox',
        sysinfo: { 'setup': true },
        default_console: 'serial',
        serial: 'ttyb',
        serial_speed: 100
    };

    async.waterfall([
        function (callback) {
            mock.newModel(function (error, model, components) {
                moray = components.moray;
                redis = components.redis;

                test.equal(error, null, 'should not encounter an error');

                moray.client.when('putObject', []);
                moray.client.when('getObject', [], { value: expSearchResults });
                moray.client.when('putObject', []);

                ModelServer.init(model);

                server = new ModelServer(uuid);
                callback();
            });
        },
        function (callback) {
            server.updateBootParams(
                {
                    boot_params: update,
                    boot_platform: 'newer'
                },
                function (modifyError) {
                    test.equal(
                        modifyError,
                        null,
                        'There should be no error');

                    test.deepEqual(
                        moray.client.history[1],
                        [
                            'putObject',
                            'cnapi_servers',
                            uuid,
                            {
                                uuid: uuid,
                                boot_params: updatedBootParams,
                                setup: true,
                                boot_platform: 'newer',
                                hostname: 'testbox',
                                sysinfo: { 'setup': true },
                                default_console: 'serial',
                                serial: 'ttyb',
                                serial_speed: 100
                            }
                        ],
                        'moray command history');
                        callback();
                });
        },
        function (callback) {
            moray.client.when('getObject', [], { value: expSearchResults });
            delete server.value;
            redis.client.when('hgetall', [], {});

            expSearchResults = {
                uuid: uuid,
                boot_params: updatedBootParams,
                setup: true,
                boot_platform: 'newer',
                hostname: 'testbox',
                sysinfo: { 'setup': true },
                default_console: 'serial',
                serial: 'ttyb',
                serial_speed: 100
            };
            server.getBootParams(function (getError, params) {
                test.equal(
                     getError,
                     null,
                'There should be no error');

                test.deepEqual(
                    params,
                    {
                        platform: 'newer',
                        kernel_args: {
                            rabbitmq: 'guest:guest:localhost:5672',
                            hostname: 'testbox',
                            original: 'value',
                            updated: 'shazbot'
                        },
                        default_console: 'serial',
                        serial: 'ttyb',
                        serial_speed: 100
                    });

                callback();
            });
        }
    ],
    function () {
        test.done();
    });
}

module.exports = nodeunit.testCase({
    setUp: setup,
    tearDown: teardown,
    'list all servers':                       testListServersAll,
    'list multiple servers by uuid':          testListServersByUuids,
    'list servers which are marked as setup': testListServersSetup,
    'fetch a particular server':              testFetchServer,
    'create server':                          testCreateServer,
    'delete a server':                        testDeleteServer,
    'reboot server':                          testRebootServer,
    'modify server':                          testModifyServer,
    'set server boot parameters':             testSetBootParameters,
    'update server boot parameters':          testUpdateBootParameters
});
