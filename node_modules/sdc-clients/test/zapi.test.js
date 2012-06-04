// Copyright 2011 Joyent, Inc.  All rights reserved.

var Logger = require('bunyan');
var restify = require('restify');
var uuid = require('node-uuid');

var ZAPI = require('../lib/index').ZAPI;



///--- Globals

var ZAPI_URL = 'http://' + (process.env.ZAPI_IP || '10.99.99.19');

var zapi = null;
var ZONE = null;
var DATASET_UUID = null;
var QUERY = null;
var CUSTOMER = '930896af-bf8c-48d4-885c-6573a94b1853';
var NETWORKS = '1e7b1f40-0204-439f-a0ae-3c05a38729f6';



///--- Helpers

function waitForState(state, callback) {
  function check() {
    return zapi.getMachine(QUERY, function(err, machine) {
      if (err)
        return callback(err);

      if (machine.state === state)
        return callback(null);

      setTimeout(check, 3000);
    });
  }

  return check();
}


///--- Tests

exports.setUp = function(callback) {
  zapi = new ZAPI({
    url: ZAPI_URL,
    retry: {
      retries: 1,
      minTimeout: 1000
    },
    log: new Logger({
      name: 'zapi_unit_test',
      stream: process.stderr,
      level: (process.env.LOG_LEVEL || 'info'),
      serializers: Logger.stdSerializers
    })
  });
  callback();
};


exports.test_list_machines = function(test) {
  zapi.listMachines(function(err, machines) {
    test.ifError(err);
    test.ok(machines);
    ZONE = machines[0].uuid;
    DATASET_UUID = machines[0].dataset_uuid;
    QUERY = {
      uuid: ZONE,
      owner_uuid: CUSTOMER
    };
    test.done();
  });
};


exports.test_list_machines_by_owner = function(test) {
  zapi.listMachines({ owner_uuid: CUSTOMER }, function(err, machines) {
    test.ifError(err);
    test.ok(machines);
    test.done();
  });
};


exports.test_get_machine = function(test) {
  zapi.getMachine(QUERY, function(err, machine) {
    test.ifError(err);
    test.ok(machine);
    test.done();
  });
};


exports.test_create_zone = function(test) {
  var opts = {
    owner_uuid: CUSTOMER,
    dataset_uuid: DATASET_UUID,
    networks: NETWORKS,
    brand: 'joyent',
    ram: 64
  };

  zapi.createMachine(opts, function(err, machine) {
    test.ifError(err);
    test.ok(machine);
    test.equal(opts.ram, machine.ram);
    QUERY = {
      uuid: machine.uuid,
      owner_uuid: CUSTOMER
    };
    test.done();
  });
};


exports.test_wait_for_running = function(test) {
  waitForState('running', function(err) {
    test.ifError(err);
    setTimeout(function () {
      // Try to avoid the reboot after zoneinit so we don't stop the zone
      // too early
      test.done();
    }, 20000);

  });
};


exports.test_stop_zone = function(test) {
  zapi.stopMachine(QUERY, function(err, machine) {
    test.ifError(err);
    test.ok(machine);
    test.done();
  });
};


exports.test_wait_for_stopped = function(test) {
  waitForState('stopped', function(err) {
    test.ifError(err);
    test.done();
  });
};


exports.test_start_zone = function(test) {
  zapi.startMachine(QUERY, function(err, machine) {
    test.ifError(err);
    test.ok(machine);
    test.done();
  });
};


exports.test_wait_for_started = function(test) {
  waitForState('running', function(err) {
    test.ifError(err);
    test.done();
  });
};


exports.test_reboot_zone = function(test) {
  zapi.rebootMachine(QUERY, function(err, machine) {
    test.ifError(err);
    test.ok(machine);
    test.done();
  });
};


exports.test_wait_for_reboot = function(test) {
  setTimeout(function () {
      waitForState('running', function(err) {
        test.ifError(err);
        test.done();
      });
  }, 3000);
};


exports.test_destroy_zone = function(test) {
  zapi.deleteMachine(QUERY, function(err, machine) {
    test.ifError(err);
    test.ok(machine);
    test.done();
  });
};


exports.test_wait_for_destroyed = function(test) {
  waitForState('destroyed', function(err) {
    test.ifError(err);
    test.done();
  });
};
