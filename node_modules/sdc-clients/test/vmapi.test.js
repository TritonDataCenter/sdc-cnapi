// Copyright 2012 Joyent, Inc.  All rights reserved.

var Logger = require('bunyan');
var restify = require('restify');
var uuid = require('node-uuid');

var VMAPI = require('../lib/index').VMAPI;
var NAPI = require('../lib/index').NAPI;



// --- Globals

var VMAPI_URL = 'http://' + (process.env.VMAPI_IP || '10.99.99.18');
var NAPI_URL = 'http://' + (process.env.NAPI_IP || '10.99.99.10');

var vmapi = null;
var napi = null;
var ZONE = null;
var IMAGE_UUID = null;
var QUERY = null;
var JOB_UUID = null;
var CUSTOMER = '930896af-bf8c-48d4-885c-6573a94b1853';
var NETWORKS = null;

var ADD_METADATA = { foo: 'bar' };
var SET_METADATA = { bar: 'baz' };


// In seconds
var TIMEOUT = 90;


// --- Helpers

function checkEqual(value, expected) {
    if ((typeof (value) === 'object') && (typeof (expected) === 'object')) {
        var exkeys = Object.keys(expected);
        for (var i = 0; i < exkeys.length; i++) {
            var key = exkeys[i];
            if (value[key] !== expected[key])
                return false;
        }

        return true;
    } else {
        return (value === expected);
    }
}

var times = 0;

function waitForValue(fn, params, prop, value, callback) {
    function check() {
        return fn.call(vmapi, params, function(err, vm) {
            if (err)
                return callback(err);

            if (checkEqual(vm[prop], value)) {
                times = 0;
                return callback(null);
            }

            times++;

            if (times == TIMEOUT) {
                throw new Error('Timeout after ' + TIMEOUT + ' seconds');
            }

            return setTimeout(check, 1000);
        });
    }

    return check();
}


// --- Tests

exports.setUp = function (callback) {
    var logger = new Logger({
            name: 'vmapi_unit_test',
            stream: process.stderr,
            level: (process.env.LOG_LEVEL || 'info'),
            serializers: Logger.stdSerializers
    });

    vmapi = new VMAPI({
        url: VMAPI_URL,
        retry: {
            retries: 1,
            minTimeout: 1000
        },
        log: logger
    });

    napi = new NAPI({
        url: NAPI_URL,
        retry: {
            retries: 1,
            minTimeout: 1000
        },
        log: logger
    });

    callback();
};



exports.test_list_networks = function (test) {
    napi.listNetworks({}, function (err, networks) {
        test.ifError(err);
        test.ok(networks);
        NETWORKS = networks[0].uuid;
        test.done();
    });
};


exports.test_list_vms = function (test) {
    vmapi.listVms(function (err, vms) {
        test.ifError(err);
        test.ok(vms);
        ZONE = vms[0].uuid;
        IMAGE_UUID = vms[0].image_uuid;
        QUERY = {
            uuid: ZONE,
            owner_uuid: CUSTOMER
        };
        test.done();
    });
};


exports.test_list_vms_by_owner = function (test) {
    vmapi.listVms({ owner_uuid: CUSTOMER }, function (err, vms) {
        test.ifError(err);
        test.ok(vms);
        test.done();
    });
};


exports.test_get_vm = function (test) {
    vmapi.getVm(QUERY, function (err, vm) {
        test.ifError(err);
        test.ok(vm);
        test.done();
    });
};


exports.test_create_zone = function (test) {
    var opts = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE_UUID,
        networks: NETWORKS,
        brand: 'joyent-minimal',
        ram: 64
    };

    vmapi.createVm(opts, function (err, job) {
        test.ifError(err);
        test.ok(job);
        ZONE = job.vm_uuid;
        JOB_UUID = job.job_uuid;
        QUERY = {
            uuid: ZONE,
            owner_uuid: CUSTOMER
        };
        test.done();
    });
};


exports.test_wait_for_running_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_running = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'state', 'running', function (err) {
        test.ifError(err);
        setTimeout(function () {
            // Try to avoid the reboot after zoneinit so we don't stop the zone
            // too early
            test.done();
        }, 10000);
    });
};


exports.test_update_zone = function (test) {
    var UPDATE_QUERY = {
        uuid: ZONE,
        owner_uuid: CUSTOMER,
        alias: 'foobar'
    };

    vmapi.updateVm(UPDATE_QUERY, function (err, job) {
        test.ifError(err);
        test.ok(job);
        JOB_UUID = job.job_uuid;
        test.done();
    });
};


exports.test_wait_for_updated_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_updated = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'alias', 'foobar', function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_add_metadata = function (test) {
    var MDATA_QUERY = {
        uuid: ZONE,
        owner_uuid: CUSTOMER,
        foo: 'bar'
    };

    vmapi.addMetadata('tags', MDATA_QUERY, function (err, job) {
        test.ifError(err);
        test.ok(job);
        JOB_UUID = job.job_uuid;
        test.done();
    });
};


exports.test_wait_for_add_metadata_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_add_metadata = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'tags', ADD_METADATA, function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_list_metadata = function (test) {
    vmapi.listMetadata('tags', QUERY, function (err, md) {
        test.ifError(err);
        test.ok(md.foo);
        test.done();
    });
};


exports.test_get_metadata = function (test) {
    vmapi.getMetadata('tags', 'foo', QUERY, function (err, md) {
        test.ifError(err);
        test.ok(md);
        test.done();
    });
};


exports.test_set_metadata = function (test) {
    var MDATA_QUERY = {
        uuid: ZONE,
        owner_uuid: CUSTOMER,
        bar: 'baz'
    };

    vmapi.setMetadata('tags', MDATA_QUERY, function (err, job) {
        test.ifError(err);
        test.ok(job);
        JOB_UUID = job.job_uuid;
        test.done();
    });
};


exports.test_wait_for_set_metadata_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_set_metadata = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'tags', SET_METADATA, function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_delete_metadata = function (test) {
    var MDATA_QUERY = {
        uuid: ZONE,
        owner_uuid: CUSTOMER
    };

    vmapi.deleteAllMetadata('tags', MDATA_QUERY, function (err, job) {
        test.ifError(err);
        test.ok(job);
        JOB_UUID = job.job_uuid;
        test.done();
    });
};


exports.test_wait_for_no_metadata_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_no_metadata = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'tags', {}, function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_stop_zone = function (test) {
    vmapi.stopVm(QUERY, function (err, job) {
        test.ifError(err);
        test.ok(job);
        JOB_UUID = job.job_uuid;
        test.done();
    });
};


exports.test_wait_for_stopped_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_stopped = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'state', 'stopped', function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_start_zone = function (test) {
    vmapi.startVm(QUERY, function (err, job) {
        test.ifError(err);
        test.ok(job);
        JOB_UUID = job.job_uuid;
        test.done();
    });
};


exports.test_wait_for_started_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_started = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'state', 'running', function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_reboot_zone = function (test) {
    vmapi.rebootVm(QUERY, function (err, job) {
        test.ifError(err);
        test.ok(job);
        JOB_UUID = job.job_uuid;
        test.done();
    });
};


exports.test_wait_for_reboot_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_reboot = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'state', 'running', function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_destroy_zone = function (test) {
    vmapi.deleteVm(QUERY, function (err, job) {
        test.ifError(err);
        test.ok(job);
        JOB_UUID = job.job_uuid;
        test.done();
    });
};


exports.test_wait_for_destroyed_job = function (test) {
    waitForValue(vmapi.getJob, JOB_UUID, 'execution', 'succeeded',
      function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_wait_for_destroyed = function (test) {
    waitForValue(vmapi.getVm, QUERY, 'state', 'destroyed', function (err) {
        test.ifError(err);
        test.done();
    });
};


exports.test_list_jobs = function (test) {
    var query = {
        vm_uuid: ZONE,
        task: 'provision'
    };

    vmapi.listJobs(query, function (err, jobs) {
        test.ifError(err);
        test.ok(jobs);
        JOB_UUID = jobs[0].uuid;
        test.done();
    });
};

exports.test_get_job = function (test) {
    vmapi.getJob(JOB_UUID, function (err, job) {
        test.ifError(err);
        test.ok(job);
        test.done();
    });
};
