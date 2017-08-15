/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * test-servers.js: Tests for servers endpoint.
 */

var async = require('async');
var http = require('http');
var restify = require('restify');
var sprintf = require('sprintf');
var util = require('util');


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
    'list servers': testListServers,
    'list servers with vms': testListServersWithVms,
    'list servers with memory': testListServersWithMemory,
    'list servers with disk': testListServersWithDisk,
    'list servers with capacity': testListServersWithCapacity,
    'list servers with all 1': testListServersWithAll1,
    'list servers with all 2': testListServersWithAll2,
    'list servers using unknown parameter': testListServersUnknownParam,
    'get server': testGetServer,
    'update server': testUpdateServer
};
