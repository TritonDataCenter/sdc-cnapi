/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var util = require('util');

var async = require('async');
var bunyan = require('bunyan');
var wf = require('../lib/workflows/server-sysinfo');
var VError = require('verror').VError;

var LOG = bunyan.createLogger({
    name: 'test-wf-sysinfo',
    serializers: bunyan.stdSerializers,
    streams: [ {
        level: process.env.LOG_LEVEL || 'fatal',
        stream: process.stderr
    } ]
});
var NAPI = { };
var ADMIN_UUID = '9f0cc641-5f9e-476b-b5fc-8cc7cf7eaf90';
var SERVER_UUID = '28d796de-ae2d-4625-ac8a-c3c341dcd251';



// --- Helpers



function clone(obj) {
    var newObj = {};
    for (var o in obj) {
        newObj[o] = obj[o];
    }

    return newObj;
}



// --- NAPI mock



function resetNAPI(test) {
    NAPI = {
        aggrs: {},
        nics: {},
        nictags: {}
    };
    test.done();
}


function napiAggrs() {
    return Object.keys(NAPI.aggrs).map(function (a) {
        return clone(NAPI.aggrs[a]);
    }).sort(function (a, b) {
        return a.name - b.name;
    });
}


function napiNics() {
    return Object.keys(NAPI.nics).map(function (m) {
        return clone(NAPI.nics[m]);
    }).sort(function (a, b) {
        return a.mac - b.mac;
    });

}


function napiNicTags() {
    return Object.keys(NAPI.nictags).sort();
}


function MockNAPI(opts) {
    this.opts = opts;
}

MockNAPI.prototype.createAggr = function createAggr(params, cb) {
    if (!params.hasOwnProperty('macs')) {
        cb(new Error('createAggr: missing macs'));
        return;
    }
    if (!params.hasOwnProperty('name')) {
        cb(new Error('createAggr: missing name'));
        return;
    }

    var key = SERVER_UUID + '-' + params.name;

    if (NAPI.aggrs.hasOwnProperty(key)) {
        cb(new VError('aggr %s already exists', key));
        return;
    }

    var newAggr = clone(params);
    newAggr.belongs_to_uuid = SERVER_UUID;
    newAggr.id = key;
    NAPI.aggrs[key] = newAggr;

    LOG.debug({ aggr: newAggr }, 'creating aggr %s', key);
    cb(null, clone(newAggr));
    return;
};


MockNAPI.prototype.createNic = function createNic(mac, params, cb) {
    if (NAPI.nics.hasOwnProperty(mac)) {
        cb(new VError('nic %s already exists', mac));
        return;
    }

    NAPI.nics[mac] = clone(params);
    cb(null, clone(params));
    return;
};


MockNAPI.prototype.createNicTag = function createNicTag(name, cb) {
    if (NAPI.nictags.hasOwnProperty(name)) {
        var err = new VError('nic tag %s already exists', name);
        err.body = {
            errors: [ { code: 'Duplicate' } ]
        };

        cb(err);
        return;
    }

    var params = { name: name };
    NAPI.nictags[name] = params;
    cb(null, clone(params));
    return;
};


MockNAPI.prototype.deleteAggr = function deleteAggr(id, cb) {
    if (!NAPI.aggrs.hasOwnProperty(id)) {
        cb(new VError('aggr %s does not exist', id));
        return;
    }

    delete NAPI.aggrs[id];
    cb(null, {});
    return;
};


MockNAPI.prototype.getNic = function getNic(mac, cb) {
    if (!NAPI.nics.hasOwnProperty(mac)) {
        var err = new VError('nic %s not found', mac);
        err.statusCode = 404;
        cb(err);
        return;
    }

    cb(null, clone(NAPI.nics[mac]));
};

MockNAPI.prototype.getNics = function getNics(uuid, cb) {
    var nics = [];

    for (var n in NAPI.nics) {
        var nic = NAPI.nics[n];
        if (nic.belongs_to_uuid == uuid) {
            nics.push(clone(nic));
        }
    }

    cb(null, nics);
};

MockNAPI.prototype.listAggrs = function listAggrs(params, cb) {
    var a;
    var aggr;
    var aggrs = [];
    var m;
    var newAggr;

    if (params.hasOwnProperty('macs')) {
        for (a in NAPI.aggrs) {
            aggr = aggrs[a];
            for (m in params.macs) {
                if (aggr.macs.indexOf(params.macs[m]) !== -1) {
                    newAggr = clone(aggr);
                    newAggr.id = a;
                    aggrs.push(newAggr);
                    continue;
                }
            }
        }
    }

    if (params.hasOwnProperty('belongs_to_uuid')) {
        for (a in NAPI.aggrs) {
            aggr = NAPI.aggrs[a];
            if (aggr.belongs_to_uuid == params.belongs_to_uuid) {
                newAggr = clone(aggr);
                newAggr.id = a;
                aggrs.push(newAggr);
                continue;
            }
        }
    }

    cb(null, aggrs);
};


MockNAPI.prototype.updateAggr = function updateAggr(id, params, cb) {
    if (!NAPI.aggrs.hasOwnProperty(id)) {
        cb(new VError('aggr %s does not exist', id));
        return;
    }

    for (var p in params) {
        if (p == 'id') {
            continue;
        }
        NAPI.aggrs[id][p] = params[p];
    }

    cb(null, clone(NAPI.aggrs[id]));
};


MockNAPI.prototype.updateNic = function updateNic(mac, params, cb) {
    if (!NAPI.nics.hasOwnProperty(mac)) {
        cb(new VError('nic %s does not exist', mac));
        return;
    }

    for (var p in params) {
        NAPI.nics[mac][p] = params[p];
    }

    cb(null, clone(NAPI.nics[mac]));
};



// --- Workflow running functions



function runWorkflow(test, sysinfo, callback) {
    var job = {
        log: LOG,
        params: {
            admin_uuid: ADMIN_UUID,
            server_uuid: SERVER_UUID,
            sysinfo: sysinfo
        }
    };
    var lastTaskRun = '';

    wf._setMocks({
        napiUrl: 'http://localhost',
        sdcClients: { NAPI: MockNAPI }
    });

    async.forEachSeries(wf.chain, function (task, cb) {
        LOG.debug('Running %s', task.name);
        task.body(job, function (err, res) {
            if (err) {
                LOG.error(err, 'Error running task %s', task.name);
            }

            if (res) {
                LOG.info('Task %s result: %s', task.name, res);
            }

            lastTaskRun = task.name;
            cb(err, res);
            return;
        });

        return;
    }, function (err) {
        test.ifError(err);
        test.equal(lastTaskRun, wf.chain[wf.chain.length - 1].name,
            'ran all tasks');

        callback();
    });
}


function genSysinfo(opts) {
    var base = {
        UUID: SERVER_UUID,
        'Link Aggregations': {},
        'Network Interfaces': {},
        'Virtual Network Interfaces': {}
    };

    for (var o in opts) {
        if (o == 'aggrs') {
            base['Link Aggregations'] = opts[o];
        } else if (o == 'nics') {
            base['Network Interfaces'] = opts[o];
        } else if (o == 'vnics') {
            base['Virtual Network Interfaces'] = opts[o];
        } else {
            base[o] = opts[o];
        }
    }

    LOG.debug({ sysinfo: base }, 'generated sysinfo');
    return base;
}



// --- Tests



function setup(callback) {
    callback();
}

function teardown(callback) {
    callback();
}

var d = {};

var aggrTests = {
    'reset NAPI': resetNAPI,

    'first boot': function (test) {
        d = {
            ips: [ '10.99.99.38', '10.99.99.39' ],
            macs: [ '00:0c:29:a1:d5:3e', '00:0c:29:a1:d5:48',
                '00:0c:29:a1:d5:52', '00:0c:29:a1:d5:53',
                '00:0c:29:a1:d5:54', '00:0c:29:a1:d5:55' ]
        };

        d.sysinfo = {
            aggrs: {
                aggr0: {
                   'LACP mode': 'off',
                   'Interfaces': ['e1000g1', 'e1000g2']
                }
            },

            nics: {
                'e1000g0': {
                    'MAC Address': d.macs[0],
                    'ip4addr': d.ips[0],
                    'Link Status': 'up',
                    'NIC Names': ['admin']
                },
                'e1000g1': {
                    'MAC Address': d.macs[1],
                    'ip4addr': '',
                    'Link Status': 'up',
                    'NIC Names': []
                },
                'e1000g2': {
                    'MAC Address': d.macs[2],
                    'ip4addr': '',
                    'Link Status': 'up',
                    'NIC Names': []
                },
                'aggr0': {
                    'MAC Address': d.macs[1],
                    'ip4addr': '',
                    'Link Status': 'up',
                    'NIC Names': ['internal', 'external']
                }
            }
        };

        runWorkflow(test, genSysinfo(d.sysinfo), function (err) {
            test.deepEqual(napiNicTags(), ['admin', 'external', 'internal'],
                'nic tags created');

            d.nics = [
                {
                    mac: d.macs[0],
                    ip: d.ips[0],
                    belongs_to_uuid: SERVER_UUID,
                    belongs_to_type: 'server',
                    owner_uuid: ADMIN_UUID,
                    nic_tag: 'admin',
                    nic_tags_provided: ['admin'],
                    vlan_id: 0
                },
                {
                    mac: d.macs[1],
                    belongs_to_uuid: SERVER_UUID,
                    belongs_to_type: 'server',
                    owner_uuid: ADMIN_UUID,
                    nic_tags_provided: []
                },
                {
                    mac: d.macs[2],
                    belongs_to_uuid: SERVER_UUID,
                    belongs_to_type: 'server',
                    owner_uuid: ADMIN_UUID,
                    nic_tags_provided: []
                }
            ];

            test.deepEqual(napiNics(), d.nics, 'nics created');

            d.aggrs = [
                {
                    belongs_to_uuid: SERVER_UUID,
                    id: SERVER_UUID + '-aggr0',
                    name: 'aggr0',
                    lacp_mode: 'off',
                    macs: [ d.macs[1], d.macs[2] ]
                }
            ];
            test.deepEqual(napiAggrs(), d.aggrs, 'aggrs created');

            test.done();
            return;
        });
    },

    'add / update aggrs': function (test) {
        test.ok(Object.keys(NAPI.nics).length > 0, 'still nics in NAPI');

        // Add e1000g3 to aggr0
        d.sysinfo.nics.e1000g3 = {
            'MAC Address': d.macs[3],
            'ip4addr': '',
            'Link Status': 'up',
            'NIC Names': []
        };
        d.sysinfo.aggrs.aggr0.Interfaces = ['e1000g1', 'e1000g2', 'e1000g3'];

        // Add aggr1
        d.sysinfo.nics.aggr1 = {
            'MAC Address': d.macs[4],
            'ip4addr': '',
            'Link Status': 'up',
            'NIC Names': []
        };
        d.sysinfo.aggrs.aggr1 = {
           'LACP mode': 'off',
           'Interfaces': ['e1000g4', 'e1000g5']
        };
        d.sysinfo.nics.e1000g4 = {
            'MAC Address': d.macs[4],
            'ip4addr': '',
            'Link Status': 'up',
            'NIC Names': []
        };
        d.sysinfo.nics.e1000g5 = {
            'MAC Address': d.macs[5],
            'ip4addr': '',
            'Link Status': 'up',
            'NIC Names': []
        };

        // Update e1000g0
        d.sysinfo.nics.e1000g0.ip4addr = d.ips[1];

        runWorkflow(test, genSysinfo(d.sysinfo), function (err) {
            test.deepEqual(napiNicTags(), ['admin', 'external', 'internal'],
                'nic tags still around');

            d.nics[0].ip = d.ips[1];
            d.nics = d.nics.concat([
                {
                    mac: d.macs[3],
                    belongs_to_uuid: SERVER_UUID,
                    belongs_to_type: 'server',
                    owner_uuid: ADMIN_UUID,
                    nic_tags_provided: []
                },
                {
                    mac: d.macs[4],
                    belongs_to_uuid: SERVER_UUID,
                    belongs_to_type: 'server',
                    owner_uuid: ADMIN_UUID,
                    nic_tags_provided: []
                },
                {
                    mac: d.macs[5],
                    belongs_to_uuid: SERVER_UUID,
                    belongs_to_type: 'server',
                    owner_uuid: ADMIN_UUID,
                    nic_tags_provided: []
                }
            ]);

            test.deepEqual(napiNics(), d.nics, 'new nics added');

            d.aggrs[0].macs = [ d.macs[1], d.macs[2], d.macs[3] ];
            d.aggrs.push({
                belongs_to_uuid: SERVER_UUID,
                id: SERVER_UUID + '-aggr1',
                name: 'aggr1',
                lacp_mode: 'off',
                macs: [ d.macs[4], d.macs[5] ]
            });
            test.deepEqual(napiAggrs(), d.aggrs, 'new aggr added');

            test.done();
            return;
        });
    }
};

module.exports = {
    setUp: setup,
    tearDown: teardown,
    'aggregations': aggrTests
};
