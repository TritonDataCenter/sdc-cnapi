var async = require('async');
var util = require('util');
var test = require('tap').test;

var common = require('../lib/common');
var mock = require('./lib/mock');

test('list servers in datacenter', function (t) {
    t.plan(2);
    var expSearchResults = [
        null,
        [ { uuid: '1234', ram: '12345', sysinfo: '{ "setup": true }' },
          { uuid: '5678', ram: '56789', sysinfo: '{ "setup": true }' }
        ]
    ];

    mock.newModel(function (error, model, mockUfds) {
        mockUfds.when('search', [], expSearchResults);
        model.listServers({}, function (list$error, servers) {
        console.dir(servers);
            t.same(
                mockUfds.history[0],
                [ 'search',
                  'ou=servers, datacenter=testdc, o=smartdc',
                  { 'scope':'sub', 'filter': '(&(objectclass=server)(uuid=*))' }
                ],
                'ufds client parameters');

            t.same(
                servers,
                expSearchResults[1],
                'Server results should match');
            t.end();
        });
    });
});

test('list multiple servers in datacenter', function (t) {
    t.plan(2);
    var expSearchResults = [
        null,
        [ { uuid: '1234', ram: '12345', sysinfo: '{ "setup": true }' },
          { uuid: '5678', ram: '56789', sysinfo: '{ "setup": true }' }
        ]
    ];

    mock.newModel(function (error, model, mockUfds) {
        mockUfds.when('search', [], expSearchResults);
        var uuids = ['1234', '5678'];
        model.listServers({ uuid: uuids }, function (list$error, servers) {
            t.same(
                mockUfds.history[0],
                [ 'search',
                  'ou=servers, datacenter=testdc, o=smartdc',
                  { 'scope':'sub',
                    'filter':
                    '(&(objectclass=server)'
                    + '(|(uuid=1234)(uuid=5678)))' }
                ],
                'ufds client parameters');

            t.same(
                servers,
                expSearchResults[1],
                'Server results should match');
            t.end();
        });
    });
});

test('list only setup servers', function (t) {
    t.plan(1);
    var expSearchResults = [
        null,
        [ { uuid: '1234', setup: 'true', sysinfo: '{ "setup": true }' },
          { uuid: 'abcd', setup: 'true', sysinfo: '{ "setup": true }' }
        ]
    ];

    mock.newModel(function (error, model, mockUfds) {
        mockUfds.when('search', [], expSearchResults);

        model.listServers({ setup: 'true' }, function (list$error, servers) {
            t.same(
                mockUfds.history[0],
                [ 'search',
                  'ou=servers, datacenter=testdc, o=smartdc',
                  { 'scope':'sub',
                    'filter':
                    '(&(objectclass=server)'
                    + '(uuid=*)(setup=true))' }
                ],
                'ufds client parameters');

            t.end();
        });
    });
});

test('delete servers in datacenter', function (t) {
    var uuid = '550e8400-e29b-41d4-a716-446655440000';
    var dn = 'uuid='+uuid+',ou=servers, datacenter=testdc, o=smartdc';

    var expSearchResults = [
        null,
        [ {
            uuid: uuid,
            ram: '12345',
            dn: dn
          }
        ]
    ];

    t.plan(1);
    mock.newModel(function (error, model, mockUfds) {
        mockUfds.when('search', [], expSearchResults);
        mockUfds.when('del', [], []);

        model.deleteServer(uuid, function (list$error) {
            t.same(
                [
                    [ 'search',
                      dn,
                      {}
                    ],
                    [ 'del',
                      dn
                    ]
                ],
                mockUfds.history,
                'ufds command history');
            t.end();
        });
    });
});

test('create server in datacenter', function (t) {
    var uuid = '550e8400-e29b-41d4-a716-446655440000';
    var dn = 'uuid='+uuid+',ou=servers, datacenter=testdc, o=smartdc';
    var server = {
        uuid: uuid,
        ram: '12345'
    };

    t.plan(1);
    mock.newModel(function (error, model, mockUfds) {
        mockUfds.when('add', []);

        model.createServer(server, function (list$error) {
            t.same(
                [
                    [ 'add',
                      dn,
                      server
                    ]
                ],
                mockUfds.history,
                'ufds command history');
            t.end();
        });
    });
});
