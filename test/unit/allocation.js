/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */

/*
 * Runs allocations through CNAPI's Designation with the dapi config rendered
 * from the SAPI template, the way config-agent renders it. These need no
 * Triton deployment: the only stub is the VMAPI call that lists a server's
 * VMs. Run with `make test-unit`.
 *
 * This file is not named test-*.js so that test/runtests, which runs the
 * tests that need a deployment, does not pick it up.
 */

var fs = require('fs');
var path = require('path');

var bunyan = require('bunyan');
var hogan = require('hogan.js');
var nodeunit = require('nodeunit');

var Designation = require('../../lib/designation');
var ModelVm = require('../../lib/models/vm');


var TEMPLATE = path.join(__dirname, '..', '..', 'sapi_manifests', 'cnapi',
    'template');

var MiB = 1024 * 1024;
var GiB = 1024 * MiB;
var TiB = 1024 * GiB;

var PLATFORM = '20250101T000000Z';
var OWNER = 'b4f66289-c30f-4d29-9645-21f8f939bcb2';
// Tickets belong to another owner, so that DAPI's spreading of an owner's VMs
// across servers does not affect which servers are left.
var OTHER_OWNER = '0ddc0513-f414-4ee5-81cc-7b716fd04a6a';
var IMAGE_UUID = '80072e7c-8e53-44d0-8755-2cbef6151c03';
var SERVER_A = '00000000-0000-0000-0000-00000000000a';
var SERVER_B = '00000000-0000-0000-0000-00000000000b';

var TICKETED_STEP = 'Add VMs which have open provisioning tickets';
var MIN_DISK_STEP = 'Servers with enough unreserved disk';
var DISK_SCORE_STEP = 'Score servers based on unreserved disk';


/*
 * Renders the CNAPI config from the SAPI template with the given metadata,
 * as config-agent does.
 */
function renderConfig(metadata) {
    var template = fs.readFileSync(TEMPLATE, 'utf8');

    return JSON.parse(hogan.compile(template).render(metadata));
}


/*
 * Initializes Designation from the rendered template and calls back once its
 * allocator has finished loading.
 */
function initDesignation(metadata, cb) {
    var config = renderConfig(metadata);

    Designation.init({
        config: config,
        log: bunyan.createLogger({ name: 'test-unit', level: 'fatal' })
    });

    (function waitForAllocator() {
        if (!Designation.allocator.serverCapacityExpr) {
            setTimeout(waitForAllocator, 10);
            return;
        }
        cb(config);
    })();
}


function server(uuid, poolSize) {
    return {
        uuid: uuid,
        hostname: uuid.slice(-1),
        status: 'running',
        setup: true,
        reserved: false,
        headnode: false,
        current_platform: PLATFORM,
        boot_platform: PLATFORM,
        traits: {},
        reservation_ratio: 0.15,
        overprovision_ratios: {},
        memory_available_bytes: 256 * GiB,
        memory_arc_bytes: 0,
        memory_total_bytes: 256 * GiB,
        disk_pool_size_bytes: poolSize,
        disk_pool_alloc_bytes: 0,
        disk_system_used_bytes: 0,
        disk_installed_images_used_bytes: 0,
        disk_cores_quota_bytes: 0,
        disk_cores_quota_used_bytes: 0,
        disk_zone_quota_bytes: 0,
        disk_zone_quota_used_bytes: 0,
        disk_kvm_quota_bytes: 0,
        disk_kvm_zvol_used_bytes: 0,
        disk_kvm_zvol_volsize_bytes: 0,
        sysinfo: {
            'UUID': uuid,
            'Live Image': PLATFORM,
            'System Type': 'SunOS',
            'SDC Version': '7.0',
            'Setup': 'true',
            'VM Capable': true,
            'Bhyve Capable': true,
            'Bhyve Max Vcpus': 32,
            'HVM API': true,
            'CPU Total Cores': 32,
            'MiB of Memory': String(256 * 1024),
            'Network Interfaces': {},
            'Virtual Network Interfaces': {}
        },
        vms: {}
    };
}


function bhyveRequest(flexSize) {
    return {
        vm: {
            vm_uuid: '6c5ac296-ff76-4581-8d39-4b3c35484082',
            owner_uuid: OWNER,
            brand: 'bhyve',
            ram: 1024,
            vcpus: 2,
            cpu_cap: 100,
            flexible_disk_size: flexSize,
            disks: [ {
                image_uuid: IMAGE_UUID,
                image_size: 10 * 1024,
                boot: true
            }, {
                size: flexSize - 10 * 1024
            } ]
        },
        img: {
            uuid: IMAGE_UUID,
            type: 'zvol',
            os: 'linux',
            image_size: 10 * 1024,
            files: [ { size: 1 * GiB } ]
        },
        pkg: {
            uuid: '84a7a8ea-29b5-47af-9bf4-148c2a11368c',
            brand: 'bhyve',
            max_physical_memory: 1024,
            cpu_cap: 100,
            quota: flexSize,
            flexible_disk: true
        }
    };
}


function bhyveTicket(serverUuid, vmUuid, extra) {
    extra.owner_uuid = OTHER_OWNER;
    extra.brand = 'bhyve';
    extra.max_physical_memory = 1024;
    extra.cpu_cap = 100;

    return {
        uuid: vmUuid,
        server_uuid: serverUuid,
        scope: 'vm',
        id: vmUuid,
        action: 'provision',
        status: 'active',
        extra: extra
    };
}


function allocate(servers, request, tickets, cb) {
    Designation.allocate(servers, request.vm, request.img, request.pkg,
        tickets, cb);
}


function findStep(steps, name) {
    return steps.filter(function (step) {
        return step.step === name;
    })[0];
}


/*
 * Returns how much a scoring step increased a server's score, parsed from the
 * step's reason ("increased score by 1.00 to 3.00").
 */
function scoreIncrease(step, serverUuid) {
    var match = /^increased score by ([0-9.]+) /.exec(
        step.reasons[serverUuid]);

    return match ? Number(match[1]) : NaN;
}


function stubServerVms(test, cb) {
    var listVms = ModelVm.listVmsViaVmapi;

    ModelVm.listVmsViaVmapi = function listNoVms(_, listCb) {
        listCb(null, []);
    };

    cb(function restore() {
        ModelVm.listVmsViaVmapi = listVms;
        test.done();
    });
}


function testDefaultPipeline(test) {
    initDesignation({}, function (config) {
        var algos = config.dapi.allocationDescription;

        test.strictEqual(algos.indexOf('hard-filter-min-disk'), -1,
            'hard-filter-min-disk is not in the default pipeline');
        test.notStrictEqual(algos.indexOf('calculate-ticketed-vms'), -1,
            'calculate-ticketed-vms is in the default pipeline');
        test.done();
    });
}


function testMinDiskEnabled(test) {
    initDesignation({ ALLOC_FILTER_MIN_DISK: true }, function (config) {
        var algos = config.dapi.allocationDescription;

        test.strictEqual(algos.indexOf('hard-filter-min-disk'),
            algos.indexOf('hard-filter-min-cpu') + 1,
            'hard-filter-min-disk follows hard-filter-min-cpu');
        test.done();
    });
}


/*
 * A bhyve VM still provisioning on server A has a ticket instead of a VM
 * record. Its root and flexible disk limit count against A's unreserved disk,
 * which leaves A otherwise identical to B and not filtered out. With the
 * default positive weight_unreserved_disk, DAPI packs servers: the server with
 * less unreserved disk scores higher.
 */
function testTicketLowersDiskScore(test) {
    stubServerVms(test, function (done) {
        initDesignation({}, function () {
            var servers = [ server(SERVER_A, 4 * TiB),
                server(SERVER_B, 4 * TiB) ];
            var tickets = [
                bhyveTicket(SERVER_A, 'd1a5b6ba-c8ca-4b3c-90b8-1cbbe0a1e6b8', {
                    image_size: 10 * 1024,
                    flexible_disk_size: 1024 * 1024,
                    disks: [ {
                        image_uuid: IMAGE_UUID,
                        image_size: 10 * 1024
                    }, {
                        size: 1024 * 1024 - 10 * 1024
                    } ]
                })
            ];

            allocate(servers, bhyveRequest(100 * 1024), tickets,
                    function (err, _, steps) {
                test.ifError(err);

                // 1 GiB bhyve root + 1 TiB flexible disk, in MiB
                test.strictEqual(
                    servers[1].unreserved_disk - servers[0].unreserved_disk,
                    (1 + 1024) * 1024,
                    'ticket is counted against its server\'s unreserved disk');

                var scored = findStep(steps, DISK_SCORE_STEP);
                test.deepEqual(scored.remaining.sort(), [ SERVER_A, SERVER_B ],
                    'both servers reach disk scoring');
                test.ok(scoreIncrease(scored, SERVER_A) >
                    scoreIncrease(scored, SERVER_B),
                    'server with the ticket scores higher on disk: ' +
                    JSON.stringify(scored.reasons));
                done();
            });
        });
    });
}


/*
 * A ticket whose disk size DAPI cannot determine removes its server from the
 * allocation until the ticket is gone.
 */
function testUnsizedTicketSkipsServer(test) {
    stubServerVms(test, function (done) {
        initDesignation({}, function () {
            var servers = [ server(SERVER_A, 4 * TiB),
                server(SERVER_B, 4 * TiB) ];
            var tickets = [
                bhyveTicket(SERVER_A, 'f4b9e3a6-0d2c-4f1b-b5e8-7a6c5d4e3f21', {
                    image_size: 10 * 1024,
                    disks: [ {
                        image_uuid: IMAGE_UUID,
                        image_size: 10 * 1024
                    }, {
                        size: 'remaining'
                    } ]
                })
            ];

            allocate(servers, bhyveRequest(100 * 1024), tickets,
                    function (err, chosen, steps) {
                test.ifError(err);
                test.deepEqual(findStep(steps, TICKETED_STEP).remaining,
                    [ SERVER_B ]);
                test.strictEqual(chosen.uuid, SERVER_B);
                done();
            });
        });
    });
}


/*
 * A ticket's image_size is copied from the image by VMAPI. If one ever holds
 * something other than a number, allocation must still complete: an exception
 * here is not caught before it reaches the process.
 */
function testMalformedTicketDoesNotThrow(test) {
    stubServerVms(test, function (done) {
        initDesignation({}, function () {
            var servers = [ server(SERVER_A, 4 * TiB),
                server(SERVER_B, 4 * TiB) ];
            var tickets = [
                bhyveTicket(SERVER_A, '5d8a3b2e-1c4f-4a7b-9e6d-3f2a1b0c9d8e', {
                    image_size: '10240',
                    disks: [ {
                        image_uuid: IMAGE_UUID
                    }, {
                        size: 25600
                    } ]
                })
            ];

            try {
                allocate(servers, bhyveRequest(100 * 1024), tickets,
                        function (err, chosen) {
                    test.ifError(err);
                    test.ok(chosen, 'a server was chosen');
                    done();
                });
            } catch (e) {
                test.ok(false, 'allocation threw: ' + e.message);
                done();
            }
        });
    });
}


/*
 * With ALLOC_FILTER_MIN_DISK=true, a server without room for a 1 TiB
 * flexible disk bhyve VM is filtered out.
 */
function testMinDiskFiltersSmallServer(test) {
    stubServerVms(test, function (done) {
        initDesignation({ ALLOC_FILTER_MIN_DISK: true }, function () {
            var servers = [ server(SERVER_A, 1 * TiB),
                server(SERVER_B, 4 * TiB) ];

            allocate(servers, bhyveRequest(1024 * 1024), [],
                    function (err, chosen, steps) {
                test.ifError(err);

                var step = findStep(steps, MIN_DISK_STEP);
                test.deepEqual(step.remaining, [ SERVER_B ]);
                test.ok(/^VM's calculated [0-9]+ MiB disk is more than /.test(
                    step.reasons[SERVER_A]), step.reasons[SERVER_A]);
                test.strictEqual(chosen.uuid, SERVER_B);
                done();
            });
        });
    });
}


module.exports = nodeunit.testCase({
    'default pipeline has no hard-filter-min-disk': testDefaultPipeline,
    'ALLOC_FILTER_MIN_DISK=true adds hard-filter-min-disk': testMinDiskEnabled,
    'provision ticket counts against its server\'s disk':
        testTicketLowersDiskScore,
    'unsized provision ticket skips its server': testUnsizedTicketSkipsServer,
    'malformed provision ticket does not throw':
        testMalformedTicketDoesNotThrow,
    'min-disk filter rejects a server without room':
        testMinDiskFiltersSmallServer
});
