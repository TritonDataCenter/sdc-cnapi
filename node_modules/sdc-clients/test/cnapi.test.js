// Copyright 2011 Joyent, Inc.  All rights reserved.

var Logger = require('bunyan');
var restify = require('restify');
var uuid = require('node-uuid');

var CNAPI = require('../lib/index').CNAPI;



///--- Globals

var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.17');

var SERVER = null;
var ZONE = uuid();
var TASK = null;
var DATASET_UUID = '01b2c898-945f-11e1-a523-af1afbe22822';
var CUSTOMER = '930896af-bf8c-48d4-885c-6573a94b1853';

///--- Helpers

function waitForTask(callback) {
  function check() {
    return cnapi.getTask(TASK, function(err, task) {
      if (err)
        return callback(err);

      if (task.status == 'failure')
        return callback('Task failed');

      if (task.status == 'complete')
        return callback(null);

      setTimeout(check, 3000);
    });
  }

  return check();
}


///--- Tests

exports.setUp = function(callback) {
  cnapi = new CNAPI({
    url: CNAPI_URL,
    username: 'admin',
    password: 'lbpass123',
    retry: {
      retries: 1,
      minTimeout: 1000
    },
    log: new Logger({
      name: 'cnapi_unit_test',
      stream: process.stderr,
      level: (process.env.LOG_LEVEL || 'info'),
      serializers: Logger.stdSerializers
    })
  });
  callback();
};


exports.test_list_servers = function(test) {
  cnapi.listServers(function(err, servers) {
    test.ifError(err);
    test.ok(servers);
    SERVER = servers[0].uuid;
    test.done();
  });
};


exports.test_get_server = function(test) {
  cnapi.getServer(SERVER, function(err, server) {
    test.ifError(err);
    test.ok(server);
    test.done();
  });
};


exports.test_create_vm = function(test) {
  var opts = {
    uuid: ZONE,
    owner_uuid: CUSTOMER,
    dataset_uuid: DATASET_UUID,
    brand: 'joyent',
    ram: 64
  };

  cnapi.createVm(SERVER, opts, function(err, task) {
    test.ifError(err);
    test.ok(task);
    TASK = task.id;
    test.done();
  });
};


exports.test_wait_for_running = function(test) {
  waitForTask(function(err) {
    test.ifError(err);
    test.done();
  });
};


exports.test_get_vm = function(test) {
  setTimeout(function() {
    cnapi.getVm(SERVER, ZONE, function(err, vm) {
      test.ifError(err);
      test.ok(vm);
      test.done();
    });
  }, 10000);
};


exports.test_stop_vm = function(test) {
  cnapi.stopVm(SERVER, ZONE, function(err, task) {
    test.ifError(err);
    test.ok(task);
    TASK = task.id;
    test.done();
  });
};


exports.test_wait_for_stopped = function(test) {
  waitForTask(function(err) {
    test.ifError(err);
    test.done();
  });
};


// Wait 3 seconds after the job completes
exports.test_start_vm = function(test) {
  setTimeout(function() {
    cnapi.startVm(SERVER, ZONE, function(err, task) {
      test.ifError(err);
      test.ok(task);
      TASK = task.id;
      test.done();
    });
  }, 3000);
};


exports.test_wait_for_started = function(test) {
  waitForTask(function(err) {
    test.ifError(err);
    test.done();
  });
};


exports.test_reboot_vm = function(test) {
  setTimeout(function() {
    cnapi.rebootVm(SERVER, ZONE, function(err, task) {
      test.ifError(err);
      test.ok(task);
      TASK = task.id;
      test.done();
    });
  }, 3000);
};


exports.test_wait_for_reboot = function(test) {
  waitForTask(function(err) {
    test.ifError(err);
    test.done();
  });
};


exports.test_delete_vm = function(test) {
  setTimeout(function() {
    cnapi.deleteVm(SERVER, ZONE, function(err, task) {
      test.ifError(err);
      test.ok(task);
      TASK = task.id;
      test.done();
    });
  }, 3000);
};


exports.test_wait_for_deleted = function(test) {
  waitForTask(function(err) {
    test.ifError(err);
    test.done();
  });
};
