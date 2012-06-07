var path = require('path');
var async = require('async');
var util = require('util');
var test = require('tap').test;

var common = require('../lib/common');
var createModel = require('../lib/models').createModel;

var configFilename = path.join(__dirname, '..', 'config', 'test-config.json');


function MockUfds() {
    this.history = [];
    this.callbackValues = {
        del: [],
        search: [],
        add: []
    };
}

MockUfds.prototype.search = function (baseDn, options, callback) {
    this.history.push(['search', baseDn, options]);
    callback.apply(null, this.callbackValues.search.pop());
    return;
};

MockUfds.prototype.del = function (itemDn, callback) {
    this.history.push(['del', itemDn]);
    callback.apply(null, []);
    return;
};

MockUfds.prototype.add = function (baseDn, server, callback) {
    this.history.push(['add', baseDn, server]);
    callback.apply(null, []);
    return;
};

MockUfds.prototype.when = function (fn, arguments, results) {
    this.callbackValues[fn].push(results);
};

function newModel(callback) {
    var config;
    var model;

    var logFn = function () {};
    var log = {
        debug: logFn,
        info: logFn
    };

    var ufds = new MockUfds();

    async.waterfall([
        function (wf$callback) {
            common.loadConfig(configFilename, function (error, c) {
                config = c;
                return wf$callback();
            });
        },
        function (wf$callback) {
            model = createModel({
                log: log,
                ufds: config.ufds,
                datacenter: config.datacenter_name
            });
            model.setUfds(ufds);
            wf$callback();
        }
    ],
    function (error) {
        return callback(error, model, ufds);
    });
}

test('list servers in datacenter', function (t) {
    t.plan(2);
    var expSearchResults = [
        null,
        [ { uuid: '1234', ram: '12345' },
          { uuid: '5678', ram: '56789' }
        ]
    ];

    newModel(function (error, model, mockUfds) {
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
        [ { uuid: '1234', ram: '12345' },
          { uuid: '5678', ram: '56789' }
        ]
    ];

    newModel(function (error, model, mockUfds) {
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
        [ { uuid: '1234', setup: 'true' },
          { uuid: 'abcd', setup: 'true' }
        ]
    ];

    newModel(function (error, model, mockUfds) {
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
    newModel(function (error, model, mockUfds) {
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
    newModel(function (error, model, mockUfds) {
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
