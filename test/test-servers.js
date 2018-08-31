/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * test-servers.js: Tests for servers endpoint.
 */

var http = require('http');
var util = require('util');

var async = require('async');
var libuuid = require('libuuid');
var jsprim = require('jsprim');
var restify = require('restify');
var sprintf = require('sprintf');


var CNAPI_URL = 'http://' + (process.env.CNAPI_IP || '10.99.99.22');
var client;


function setup(callback) {
    client = restify.createJsonClient({
        agent: false,
        url: CNAPI_URL
    });

    client.basicAuth('admin', 'joypass123');

    callback();
}


function testListServers(t) {
    client.get('/servers', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            validateServer(t, server, {});
        });

        t.done();
    });
}


function testListServersWithVms(t) {
    client.get('/servers?extras=vms', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            validateServer(t, server, { vms: true });
        });

        t.done();
    });
}


function testListServersWithDisk(t) {
    client.get('/servers?extras=disk', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            validateServer(t, server, { disk: true });
        });

        t.done();
    });
}


function testListServersWithMemory(t) {
    client.get('/servers?extras=memory', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            validateServer(t, server, { memory: true });
        });

        t.done();
    });
}


function testListServersWithCapacity(t) {
    client.get('/servers?extras=capacity', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            validateServer(t, server, { capacity: true, disk: true,
                                        memory: true });
        });

        t.done();
    });
}


function testListServersWithAll1(t) {
    client.get('/servers?extras=all', function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            validateServer(t, server, { sysinfo: true, vms: true,
                                        capacity: true, disk: true,
                                        memory: true });
        });

        t.done();
    });
}


function testListServersWithAll2(t) {
    client.get('/servers?extras=vms,sysinfo,disk,memory,capacity',
               function (err, req, res, body) {
        t.ifError(err);
        t.ok(body);

        body.forEach(function (server) {
            validateServer(t, server, { sysinfo: true, vms: true,
                                        capacity: true, disk: true,
                                        memory: true });
        });

        t.done();
    });
}


function testListServersUnknownParam(t) {
    client.get('/servers?unknown=true', function (err, req, res, body) {
        t.expect(2);
        t.ok(err);
        t.equal(err.statusCode, 409);
        t.done();
    });
}


// Entries that allocator depends on aren't populated by CNAPI for 10-15 seconds
// after CNAPI starts. During that interval, this test will fail.
function testGetServer(t) {
    client.get('/servers?headnode=true', function (err, req, res, body) {
        t.ifError(err);
        var uuid = body[0].uuid;

        client.get('/servers/' + uuid, function (err2, req2, res2, body2) {
            t.ifError(err2);

            validateServer(t, body2, { sysinfo: true, vms: true,
                                       capacity: true, disk: true,
                                       memory: true });
            t.done();
        });
    });
}


function testUpdateServer(t) {
    var uuid;
    var oldRatio;
    var oldNextReboot;

    async.waterfall([
        function (next) {
            client.get('/servers?headnode=true',
                       function (err, req, res, body) {
                if (err) {
                    next(err);
                    return;
                }

                uuid = body[0].uuid;
                oldRatio = body[0].reservation_ratio;
                oldNextReboot = body[0].next_reboot;

                next();
            });
        },
        function (next) {
            var changes = {
                reservation_ratio: 0.50,
                next_reboot: '2016-04-22T12:50:40.512Z'
            };

            client.post('/servers/' + uuid, changes,
                        function (err, req, res, body) {
                next(err);
            });
        },
        function (next) {
            client.get('/servers/' + uuid, function (err, req, res, body) {
                if (err) {
                    next(err);
                    return;
                }

                t.equal(body.reservation_ratio, 0.50,
                    'ensure reservation ratio is 0.50');
                t.equal(body.next_reboot, '2016-04-22T12:50:40.512Z',
                    'ensure next_reboot timestamp is correct');

                next();
            });
        },
        function (next) {
            var changes = { next_reboot: '' };

            client.post('/servers/' + uuid, changes,
                        function (err, req, res, body) {
                next(err);
            });
        },
        function (next) {
            client.get('/servers/' + uuid, function (err, req, res, body) {
                if (err) {
                    next(err);
                    return;
                }

                t.equal(body.next_reboot, '',
                    'ensure "next_reboot" attribute is cleared');

                next();
            });
        }
    ], function (err) {
        var changes = {
            reservation_ratio: oldRatio,
            next_reboot: oldNextReboot || ''
        };

        client.post('/servers/' + uuid, changes,
                    function (err2, req, res, body) {
            t.ifError(err);
            t.ifError(err2);
            t.done();
        });
    });
}

/*
 * Test that we do not succumb to TRITON-740 while parsing
 * overprovision_ratios.
 */
function testUpdateServerOverprovisionRatios(t) {
    var uuid;
    var origRatios;

    async.waterfall([
        function (next) {
            client.get('/servers?headnode=true&extras=all',
                       function (err, req, res, body) {
                if (err) {
                    next(err);
                    return;
                }

                uuid = body[0].uuid;
                origRatios = body[0].overprovision_ratios;

                next();
            });
        },
        // Explicitly override the default value
        function (next) {
            var changes = {
                overprovision_ratios: { ram: 2 }
            };

            client.post('/servers/' + uuid, changes,
                        function (err, req, res, body) {
                next(err);
            });
        },
        function (next) {
            client.get('/servers/' + uuid, function (err, req, res, body) {
                if (err) {
                    next(err);
                    return;
                }

                // DAPI overrides these values
                t.equal(body.overprovision_ratios.ram, 1,
                    'overprovision_ratios.ram 1');
                next();
            });
        },

        function (next) {
            client.get('/servers?headnode=true&extras=all',
            function (err, req, res, body) {
                if (err) {
                    next(err);
                    return;
                }
                next();
            });
        },

        // Reset overprovision_ratio back to its original value.
        function (next) {
            var changes = {
                overprovision_ratios: origRatios
            };

            client.post('/servers/' + uuid, changes,
            function (err, req, res, body) {
                next(err);
            });
        },

        // Confirm values were reset.
        function (next) {
            client.get('/servers/' + uuid, function (err, req, res, body) {
                if (err) {
                    next(err);
                    return;
                }
                t.deepEqual(body.overprovision_ratios, origRatios,
                    'ratios should match');

                next();
            });
        }
    ], function (err) {
        t.ifError(err);
        t.done();
    });
}

//
// This test will:
//
//  * POST a new server's sysinfo into /servers/<uuid>/sysinfo
//  * ensure the server object was created
//  * POST an updated version of the same sysinfo with a new 'Boot Time'
//  * ensure that the boot time was updated in the server object
//  * DELETE the server
//
function testServerSysinfo(t) {
    // Taken from a Joyent Lab system, modified only to set UUID randomly and
    // to transpose characters in the hostname and serial number in case this
    // is actually run in that lab DC. The MAC OUIs have all been changed to
    // DEC's (00:10:FE) to prevent conflict.
    var sysinfo = {
        'Live Image': '20180128T233316Z',
        'System Type': 'SunOS',
        'Boot Time': '1517295064',
        'Datacenter Name': 'nightly-1',
        'SDC Version': '7.0',
        'Manufacturer': 'Dell Inc.',
        'Product': 'PowerEdge R710',
        'Serial Number': '4QENZE2',
        'SKU Number': '',
        'HW Version': '',
        'HW Family': '',
        'Setup': 'true',
        'VM Capable': true,
        'CPU Type': 'Intel(R) Xeon(R) CPU E5530 @ 2.40GHz',
        'CPU Virtualization': 'vmx',
        'CPU Physical Cores': 2,
        'UUID': libuuid.create(),
        'Hostname': '4QENZE2',
        'CPU Total Cores': 16,
        'MiB of Memory': '49139',
        'Zpool': 'zones',
        'Zpool Disks': 'c1t0d0',
        'Zpool Profile': 'striped',
        'Zpool Creation': 1517292626,
        'Zpool Size in GiB': 1612,
        'Disks': {
          'c1t0d0': {
            'Size in GB': 1798
          }
        },
        'Boot Parameters': {
          'module_name_0': 'networking.json',
          'hostname': '4QENZE2',
          'rabbitmq': 'guest:guest:172.25.1.20:5672',
          'rabbitmq_dns': 'guest:guest:rabbitmq.nightly-1.joyent.us:5672',
          'admin_nic': '00:10:fe:9b:62:00',
          'external_nic': '00:10:fe:9b:62:01',
          'sdc_underlay_nic': '00:10:fe:9b:62:01',
          'console': 'ttyb',
          'boot_args': '',
          'bootargs': ''
        },
        'SDC Agents': [
          {
            'name': 'cabase',
            'version': '1.0.3vmaster-20170713T010344Z-g360442e'
          },
          {
            'name': 'hagfish-watcher',
            'version': '1.0.0-master-20170712T235425Z-g020d169'
          },
          {
            'name': 'marlin',
            'version': '0.0.3'
          },
          {
            'name': 'cainstsvc',
            'version': '0.0.3vmaster-20170713T010344Z-g360442e'
          },
          {
            'name': 'smartlogin',
            'version': '0.2.1-master-20160527T190021Z-gd6f0708'
          },
          {
            'name': 'amon-agent',
            'version': '1.0.1'
          },
          {
            'name': 'amon-relay',
            'version': '1.0.1'
          },
          {
            'name': 'net-agent',
            'version': '1.4.0'
          },
          {
            'name': 'firewaller',
            'version': '1.4.0'
          },
          {
            'name': 'vm-agent',
            'version': '1.7.0'
          },
          {
            'name': 'agents_core',
            'version': '2.1.0'
          },
          {
            'name': 'cmon-agent',
            'version': '1.5.0'
          },
          {
            'name': 'cn-agent',
            'version': '2.0.2'
          },
          {
            'name': 'config-agent',
            'version': '1.5.0'
          }
        ],
        'Network Interfaces': {
          'bnx2': {
            'MAC Address': '00:10:fe:1f:2b:21',
            'ip4addr': '',
            'Link Status': 'down',
            'NIC Names': []
          },
          'bnx0': {
            'MAC Address': '00:10:fe:1f:2b:1d',
            'ip4addr': '',
            'Link Status': 'down',
            'NIC Names': []
          },
          'bnx1': {
            'MAC Address': '00:10:fe:1f:2b:1f',
            'ip4addr': '',
            'Link Status': 'down',
            'NIC Names': []
          },
          'bnx3': {
            'MAC Address': '00:10:fe:1f:2b:23',
            'ip4addr': '',
            'Link Status': 'down',
            'NIC Names': []
          },
          'igb0': {
            'MAC Address': '00:10:fe:94:e3:40',
            'ip4addr': '',
            'Link Status': 'down',
            'NIC Names': []
          },
          'ixgbe0': {
            'MAC Address': '00:10:fe:9b:62:00',
            'ip4addr': '172.25.1.39',
            'Link Status': 'up',
            'NIC Names': [
              'admin'
            ]
          },
          'igb1': {
            'MAC Address': '00:10:fe:94:e3:41',
            'ip4addr': '',
            'Link Status': 'down',
            'NIC Names': []
          },
          'ixgbe1': {
            'MAC Address': '00:10:fe:9b:62:01',
            'ip4addr': '',
            'Link Status': 'up',
            'NIC Names': [
              'external',
              'sdc_underlay'
            ]
          }
        },
        'Virtual Network Interfaces': {
          'sdc_underlay0': {
            'MAC Address': '00:10:fe:67:5e:dc',
            'ip4addr': '172.31.1.6',
            'Link Status': 'up',
            'Host Interface': 'ixgbe1',
            'Overlay Nic Tags': [
              'sdc_overlay'
            ],
            'VLAN': '2701'
          }
        },
        'Link Aggregations': {}
    };
    var updateSysinfo;
    var uuid = sysinfo.UUID;

    async.waterfall([
        function _preCreateCheck(next) {
            client.get('/servers/' + uuid, function _onGet(err, req, res) {
                t.equal(err.restCode, 'ResourceNotFound',
                    'expected ResourceNotFound before posting sysinfo');
                t.equal(res.statusCode, '404',
                    'expected 404 before posting sysinfo');

                if (err && err.restCode !== 'ResourceNotFound') {
                    next(err);
                    return;
                }

                next();
            });
        }, function _createServer(next) {
            client.post('/servers/' + uuid + '/sysinfo', {
                sysinfo: sysinfo
            }, function _onPosted(err, req, res) {
                t.ok(!err, 'expected no error posting sysinfo for ' + uuid);
                next(err);
            });
        }, function _postCreateCheck(next) {
            client.get('/servers/' + uuid, function _got(err, req, res, body) {
                var isoTime;

                t.ok(!err, 'expected no error getting after first POST');
                t.equal(res.statusCode, '200',
                    'expected 200 on GET after posting initial sysinfo');

                if (err) {
                    // Fake out body so that the tests below fail but we still
                    // have the correct number.
                    body = {
                        sysinfo: {}
                    };
                }

                isoTime = (new Date(Number(sysinfo['Boot Time']) * 1000))
                    .toISOString();

                // check a couple fields, to ensure that data looks like it
                // was copied from sysinfo to the server object.
                t.equal(body.uuid, uuid,
                    'expected server uuid to match sysinfo');
                t.equal(body.sysinfo.UUID, uuid,
                    'expected server.sysinfo.UUID to match sysinfo');
                t.equal(body.last_boot, isoTime,
                    'expected server last_boot to match ' +
                    'sysinfo["Boot Time"]');
                t.equal(body.current_platform, sysinfo['Live Image'],
                    'expected server current_platform to match ' +
                    'sysinfo["Live Image"]');

                next(err);
            });
        }, function _postNewBootTime(next) {
            updateSysinfo = jsprim.deepCopy(sysinfo);
            updateSysinfo['Boot Time'] =
                ((new Date()).getTime() / 1000).toString();

            client.post('/servers/' + uuid + '/sysinfo', {
                sysinfo: updateSysinfo
            }, function _onPosted(err, req, res) {
                t.ok(!err, 'expected no error posting sysinfo update for ' +
                    uuid);
                next(err);
            });
        }, function _postUpdateCheck(next) {
            var isoTime = (new Date(Number(updateSysinfo['Boot Time']) * 1000))
                .toISOString();

            client.get('/servers/' + uuid, function _got(err, req, res, body) {
                t.ok(!err, 'expected no error getting after update POST');
                t.equal(res.statusCode, '200',
                    'expected 200 on GET after posting updated sysinfo');

                if (err) {
                    // Fake out body so that the tests below fail but we still
                    // have the correct number.
                    body = {
                        sysinfo: {}
                    };
                }

                // Ensure that the last_boot and 'Boot Time' were updated.
                t.equal(body.last_boot, isoTime,
                    'expected server last_boot to match ' +
                    'updateSysinfo["Boot Time"]');
                t.equal(body.sysinfo['Boot Time'],
                    updateSysinfo['Boot Time'],
                    'expected server.sysinfo["Boot Time"] to match ' +
                    'updateSysinfo["Boot Time"]');

                next(err);
            });
        }
    ], function (err) {
        t.ok(!err, 'expected no errors when testing /sysinfo endpoint');
        client.del('/servers/' + uuid, function _onDelete(delErr) {
            t.ok(!delErr, 'expected no error deleting server');
            t.done();
        });
    });
}


var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var VALID_SERVER_OVERPROVISION_RESOURCES = ['cpu', 'ram', 'disk', 'io', 'net'];

function validateServer(t, server, options) {
    serverAttrTypeEqual(t, server, 'setup', 'boolean');

    if (!server.setup) {
        return;
    }

    t.ok(UUID_RE.test(server.uuid), 'ensure server.uuid was a UUID');
    serverAttrTypeEqual(t, server, 'reserved', 'boolean');
    serverAttrTypeEqual(t, server, 'reservation_ratio', 'number');

    if (server.next_reboot) {
        t.equal(server.next_reboot,
                new Date(server.next_reboot).toISOString(),
                'server.next_reboot parses as an ISO date');
    }

    var diskAttr = [
        'disk_pool_size_bytes', 'disk_installed_images_used_bytes',
        'disk_zone_quota_bytes', 'disk_kvm_quota_bytes'
    ];

    if (options.disk) {
        diskAttr.forEach(function (attr) {
            serverAttrTypeEqual(t, server, attr, 'number');
        });
    } else {
        diskAttr.forEach(function (attr) {
            t.ifError(server[attr]);
        });
    }

    var memoryAttr = ['memory_available_bytes', 'memory_total_bytes'];
    if (options.memory) {
        memoryAttr.forEach(function (attr) {
            serverAttrTypeEqual(t, server, attr, 'number');
        });
    } else {
        memoryAttr.forEach(function (attr) {
            t.ifError(server[attr]);
        });
    }


    if (server.traits) {
        var traits = server.traits;
        t.ok(typeof (traits) === 'object' && !Array.isArray(traits),
            sprintf('ensure traits object for server "%s" is not an array',
            server.uuid));
    }

    if (server.overprovision_ratios) {
        var ratios = server.overprovision_ratios;

        t.ok(typeof (ratios) === 'object' && !Array.isArray(ratios),
            sprintf('ensure ratios object for server "%s" is not an array',
            server.uuid));

        var ratioResources = Object.keys(ratios);

        for (var i = 0; i !== ratioResources.length; i++) {
            var resource = ratioResources[i];
            var ratio = ratios[resource];

            t.ok(VALID_SERVER_OVERPROVISION_RESOURCES.indexOf(resource) !== -1,
                sprintf('ensure server overprovision resource "%s" is valid',
                    resource));
            t.equal(typeof (ratio), 'number', 'ratio is a number');
        }
    }

    var sysinfo = server.sysinfo;
    if (options.sysinfo) {
        t.ok(typeof (sysinfo) === 'object' && !Array.isArray(sysinfo),
            'sysinfo object is not an array');
        t.equal(typeof (server.sysinfo['CPU Total Cores']), 'number',
            sprintf('server "%s" sysinfo "CPU Total Cores" is a number',
                server.uuid));

    } else {
        t.ifError(sysinfo);
    }

    var capAttr = ['unreserved_cpu', 'unreserved_ram', 'unreserved_disk'];
    if (options.capacity) {
        capAttr.forEach(function (attr) {
            serverAttrTypeEqual(t, server, attr, 'number');
        });
    } else {
        capAttr.forEach(function (attr) {
            t.ifError(server[attr]);
        });
    }

    var vms = server.vms;
    if (options.vms) {
        t.ok(typeof (vms) === 'object' && !Array.isArray(vms),
            'server vms object is not an array');

        var vmUuids = Object.keys(vms);

        for (i = 0; i != vmUuids.length; i++) {
            var vmUuid = vmUuids[i];
            var vm = vms[vmUuid];

            t.ok(UUID_RE.test(vm.owner_uuid), 'ensure vm.owner_uuid is a UUID');

            var numAttr = ['max_physical_memory', 'quota'];
            numAttr.forEach(function (attr) {
                if (typeof (vm[attr]) !== 'undefined') {
                    vmAttrTypeEqual(t, vm, attr, 'number');
                }
            });

            var optionalNumAttr = ['cpu_cap'];
            optionalNumAttr.forEach(function (attr) {
                if (vm[attr] !== undefined && vm[attr] !== null) {
                    vmAttrTypeEqual(t, vm, attr, 'number');
                }
            });

            vmAttrTypeEqual(t, vm, 'last_modified', 'string');
            vmAttrTypeEqual(t, vm, 'state', 'string');
        }
    } else {
        t.ifError(vms);
    }
}

function vmAttrTypeEqual(t, vm, attr, exptype) {
    t.equal(typeof (vm[attr]), exptype,
        sprintf('ensure type of vm "%s" attribute "%s" is "%s"',
            vm.uuid, attr, exptype));
}

function serverAttrTypeEqual(t, server, attr, exptype) {
    t.equal(typeof (server[attr]), exptype,
        sprintf('ensure type of server "%s" attribute "%s" is "%s"',
            server.uuid, attr, exptype));
}

module.exports = {
    setUp: setup,
    'create/modify server sysinfo': testServerSysinfo,
    'list servers': testListServers,
    'list servers with vms': testListServersWithVms,
    'list servers with memory': testListServersWithMemory,
    'list servers with disk': testListServersWithDisk,
    'list servers with capacity': testListServersWithCapacity,
    'list servers with all 1': testListServersWithAll1,
    'list servers with all 2': testListServersWithAll2,
    'list servers using unknown parameter': testListServersUnknownParam,
    'get server': testGetServer,
    'update server': testUpdateServer,
    'update server overprovision ratios': testUpdateServerOverprovisionRatios
};
