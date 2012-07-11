var util = require('util');
var sdcClients = require('../lib/index');
var restify = require('restify');
var Amon = sdcClients.Amon;
var uuid = require('node-uuid');

var amon;


// --- fixtures

var AMON_URL = 'http://' + (process.env.AMON_IP || 'localhost:8080');

// We hijack the admin user since it's always going to exist.
// TODO: Should use a test user. Might be *using* 'admin' user.
var ADMIN_UUID = '930896af-bf8c-48d4-885c-6573a94b1853';

var MACHINE_UUID = process.env.MACHINE_UUID;

// Monitor name needs to be 32 chars length max and first char must be
// alpha always:
var MONITOR = {
    'name' : 'p' + uuid().replace(/-/g, '').substring(1),
    'contacts': ['email']
};

var MONITOR_2 = {
    'name': 'p' + uuid().replace(/-/g, '').substring(1),
    'contacts': ['email']
};

var PROBE = {
    'name': 'test-probe',
    'user': ADMIN_UUID,
    'monitor': MONITOR.name,
    'type': 'machine-up',
    'machine': MACHINE_UUID
};

var PROBE_2 = {
    'name': 'test-probe-2',
    'user': ADMIN_UUID,
    'monitor': MONITOR.name,
    'type': 'machine-up',
    'machine': MACHINE_UUID
};


// --- tests

exports.setUp = function (callback) {
    if (typeof (MACHINE_UUID) === 'undefined') {
        throw new Error('MACHINE_UUID env var is required to run amon tests');
    }
    amon = new Amon({
        url: AMON_URL
    });
    callback();
};

exports.test_put_monitor = function (test) {
    amon.putMonitor(ADMIN_UUID, MONITOR.name, MONITOR, function (err, monitor) {
        test.ifError(err);
        test.ok(monitor);
        test.equal(monitor.name, MONITOR.name);
        test.equal(monitor.medium, MONITOR.medium);
        test.done();
    });
};

exports.test_put_probe = function (test) {
    amon.putProbe(ADMIN_UUID, MONITOR.name, PROBE.name, PROBE,
        function (err, probe) {
        test.ifError(err);
        test.ok(probe);
        test.equal(probe.name, PROBE.name);
        test.equal(probe.user, PROBE.user);
        test.equal(probe.machine, PROBE.machine);
        test.equal(probe.monitor, PROBE.monitor);
        test.equal(probe.type, PROBE.type);
        test.done();
    });
};

exports.test_list_probes = function (test) {
    amon.putProbe(ADMIN_UUID, MONITOR.name, PROBE_2.name, PROBE_2,
        function (err, probe) {
        test.ifError(err);
        test.ok(probe);

        amon.listProbes(ADMIN_UUID, MONITOR.name, function (err, probes) {
            test.ifError(err);
            test.ok(probes);
            test.equal(probes.length, 2);

            amon.deleteProbe(ADMIN_UUID, MONITOR.name, PROBE_2.name,
              function (err) {
                test.ifError(err);
                test.done();
            });
        });
    });
};

exports.test_get_probe = function (test) {
    amon.getProbe(ADMIN_UUID, MONITOR.name, PROBE.name, function (err, probe) {
        test.ifError(err);
        test.ok(probe);
        test.equal(probe.name, PROBE.name);
        test.equal(probe.user, PROBE.user);
        test.equal(probe.machine, PROBE.machine);
        test.equal(probe.monitor, PROBE.monitor);
        test.equal(probe.type, PROBE.type);
        test.done();
    });
};

exports.test_delete_probe = function (test) {
    amon.deleteProbe(ADMIN_UUID, MONITOR.name, PROBE.name, function (err) {
        test.ifError(err);
        amon.getProbe(ADMIN_UUID, MONITOR.name, PROBE.name, function (err) {
            test.equal(err.httpCode, 404);
            test.done();
        });
    });
};

exports.test_list_monitors = function (test) {
    amon.putMonitor(ADMIN_UUID, MONITOR_2.name, MONITOR_2,
        function (err, monitor) {
        test.ifError(err);
        amon.listMonitors(ADMIN_UUID, function (err, monitors) {
            test.ifError(err);
            test.ok(monitors);
            test.ok((monitors.length > 2), 'Found less than 2 monitors');
            amon.deleteMonitor(ADMIN_UUID, MONITOR_2.name, function (err) {
                test.ifError(err);
                test.done();
            });
        });
    });
};

exports.test_get_monitor = function (test) {
    amon.getMonitor(ADMIN_UUID, MONITOR.name, function (err, monitor) {
        test.ifError(err);
        test.ok(monitor);
        test.equal(monitor.name, MONITOR.name);
        test.equal(monitor.medium, MONITOR.medium);
        test.done();
    });
};

exports.test_delete_monitor = function (test) {
    amon.deleteMonitor(ADMIN_UUID, MONITOR.name, function (err) {
        test.ifError(err);
        setTimeout(function () {
            amon.getMonitor(ADMIN_UUID, MONITOR.name, function (err) {
                test.equal(err.httpCode, 404);
                test.done();
            });
        }, 3000);
    });
};

exports.tearDown = function (callback) {
    callback();
};
