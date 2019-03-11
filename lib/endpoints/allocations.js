/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * DAPI (allocator) endpoints. The main HTTP endpoint (/allocate) picks a server
 * where to place a new VM. Another endpoint (/capacity) returns how much spare
 * space there is on a set of servers.
 */

var async     = require('async');
var restify   = require('restify');
var zlib      = require('zlib');

var Designation   = require('../designation');
var ModelServer   = require('../models/server');
var ModelWaitlist = require('../models/waitlist');
var validation    = require('../validation/endpoints');
var common        = require('../common');
var errors        = require('../errors');


var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

var ALLOC_VALIDATION_RULES = {
    servers:  ['optional', 'isArrayType'],
    package:  ['optional', 'isObjectType'],
    image:    ['isObjectType'],
    vm:       ['isObjectType'],
    nic_tag_requirements: ['optional', 'isArrayType'],
    nic_tags: ['isArrayType']
};

var CAPACITY_VALIDATION_RULES = {
    servers:  ['optional', 'isArrayType']
};

var SERVER_CHUNK_SIZE = 50;

var VOLUMES_MSG = 'Servers containing VMs required for volumes-from';


function Allocations() {}


/* BEGIN JSSTYLED */
/**
 * Given the provided constraints, returns a server chosen to allocate a new VM,
 * as well as the steps taken to reach that decision. This does not cause the VM
 * to actually be created (see VmCreate for that), but rather returns the UUID
 * of an eligible server.
 *
 * See DAPI docs for more details on how the vm, package, image and nic_tags
 * parameters must be constructed.
 *
 * Be aware when inpecting steps output that the servers which are considered
 * for allocation must be both setup and unreserved. If a server you expected
 * does not turn up in steps output, its because the server didn't meet those
 * two criteria.
 *
 * @name SelectServer
 * @endpoint POST /allocate
 * @section Allocation API
 *
 * @param {Object} vm Various required metadata for VM construction
 * @param {Object} package Description of dimensions used to construct VM
 * @param {Object} image Description of image used to construct VM
 * @param {Array} nic_tags Names of nic tags which servers must have
 * @param {Array} servers Optionally limit which servers to consider by providing their UUIDs
 *
 * @response 200 Object Server selected and steps taken
 * @response 409 Object No server found, and steps and reasons why not
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Allocations.allocate = function handlerAllocationsAllocate(req, res, next) {
    var allocator = Designation.allocator;
    var err;

    if (validation.ensureParamsValid(req, res, ALLOC_VALIDATION_RULES)) {
        next();
        return;
    }

    var params  = req.params;
    var servers = params.servers;
    var img     = params.image;
    var pkg     = params.package;
    var vm      = params.vm;
    var tagreqs = params.nic_tag_requirements;
    var tags    = params.nic_tags;

    err = Designation.validations.validateImage(img);
    if (err) {
        invalid('image', err, res, next);
        return;
    }

    if (pkg) {
        err = Designation.validations.validatePackage(pkg);
        if (err) {
            invalid('package', err, res, next);
            return;
        }
    }

    var requirements = params.image.requirements;
    err = Designation.validations.validateVmPayload(vm, requirements);
    if (err) {
        invalid('vm', err, res, next);
        return;
    }

    if (servers) {
        for (var i = 0; i !== servers.length; i++) {
            if (!UUID_RE.test(servers[i])) {
                invalid('servers', 'invalid server UUID', res, next);
                return;
            }
        }
    }

    if (tagreqs) {
        err = Designation.validations.validateNicTagRequirements(tagreqs);
        if (err) {
            invalid('nic_tag_requirements', err, res, next);
            return;
        }
    }

    vm.nic_tag_requirements = tagreqs;

    for (i = 0; i !== tags.length; i++) {
        if (typeof (tags[i]) !== 'string') {
            invalid('nic_tags', 'invalid nic_tag', res, next);
            return;
        }
    }

    vm.nic_tags = tags;

    var log = req.log;
    var httpBody;
    var serverDetails;
    var tickets;

    async.series([
        function getAllUnreservedServers(cb) {
            getServers(log, servers, false, allocator.filterHeadnode,
                       function serversCb(err2, _details) {
                if (err2) {
                    cb(new restify.InternalError(err2.message));
                    return;
                }

                serverDetails = _details;
                cb();
            });
        },

        function getOpenTickets(cb) {
            log.debug({ servers: serverDetails },
                      'Servers found, fetching tickets...');

            getOpenProvisioningTickets(log, function (err3, _tickets) {
                if (err3) {
                    cb(new restify.InternalError(err3.message));
                    return;
                }

                tickets = _tickets;
                cb();
            });
        },

        function allocateToServer(cb) {
            log.debug({ tickets: tickets },
                      'Tickets found, running allocator...');

            common.randSort(serverDetails); // mutates with a random reorder

            // cut servers into arrays of max size SERVER_CHUNK_SIZE
            var chunks = [];
            for (var j = 0; j <= serverDetails.length; j += SERVER_CHUNK_SIZE) {
                chunks.push(serverDetails.slice(j, j + SERVER_CHUNK_SIZE));
            }

            function allocChunk() {
                var serversChunk = chunks.pop();
                var startTime = new Date();

                allocator.allocate(serversChunk, vm, img, pkg, tickets,
                        function (err2, server, stepSummary) {
                    if (err2) {
                        log.error('Error while running dapi:', err2);
                        cb(err);
                        return;
                    }

                    var deltaTime = new Date() - startTime;
                    log.debug('Allocator run took', deltaTime, 'ms');

                    logResults(log, server, serversChunk, req.params, tickets,
                               allocator.defaults, stepSummary);

                    // after allocation and logging, remove vms hash so the
                    // GC can collect it
                    serversChunk.forEach(function (s) { delete s.vms; });

                    httpBody = {
                        server: server,
                        steps: stepSummary
                    };
                    log.debug(httpBody, 'Allocator run');

                    if (server) {
                        cb();
                        return;
                    }

                    // check if we should run another chunk through dapi
                    if (chunks.length > 0) {
                        allocChunk();
                        return;
                    }

                    // XXX we need a better way of determining which step in
                    // particular we were on when the sequence came to an end
                    if (stepSummary.slice(-1)[0].step === VOLUMES_MSG) {
                        cb(new errors.VolumeServerNoResourcesError());
                        return;
                    }

                    cb(new errors.NoAllocatableServersError());
                    return;
                });
            }

            allocChunk();
        }

    ], function (asyncErr) {
        if (asyncErr) {
            next(asyncErr);
            return;
        }

        // XXX CAN WE REMOVE THIS TOO?
        httpBody.imgapiPeers = [];
        res.send(httpBody);
        next();
        return;
    });
};


/* BEGIN JSSTYLED */
/**
 * Returns how much spare capacity there is on each server, specifically RAM
 * (in MiB), CPU (in percentage of CPU, where 100 = 1 core), and disk (in MiB).
 *
 * This call isn't cheap, so it's preferable to make fewer calls, and restrict
 * the results to only the servers you're interested in by passing in the
 * desired servers' UUIDs.
 *
 * @name ServerCapacity
 * @endpoint POST /capacity
 * @section Allocation API
 *
 * @param {Array} servers Optionally limit which servers to consider by providing their UUIDs
 *
 * @response 200 Object Server capacities and any associated errors
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

Allocations.capacity = function handlerAllocationsCapacity(req, res, next) {
    if (validation.ensureParamsValid(req, res, CAPACITY_VALIDATION_RULES)) {
        next();
        return;
    }

    var servers = req.params.servers;
    var log = req.log;

    if (servers) {
        for (var i = 0; i !== servers.length; i++) {
            if (!UUID_RE.test(servers[i])) {
                invalid('servers', 'invalid server UUID', res, next);
                return;
            }
        }
    }

    getServers(log, servers, null, null,
               function serverCb(err, serverDetails) {
        if (err) {
            next(new restify.InternalError(err.message));
            return;
        }

        log.debug({ servers: serverDetails },
                      'Servers found, running capacity');

        Designation.serverCapacity(serverDetails,
                function (err2, capacities, reasons) {
            if (err2) {
                log.error(err2, 'Error while determining capacity');
                next(new restify.InternalError(err2.message));
                return;
            }

            var httpBody = {
                capacities: capacities
            };

            log.debug(httpBody, 'Capacity run');

            res.send(httpBody);
            next();
            return;
        });
    });

    return;
};


function getServers(log, serverUuids, reserved, filterHeadnode, cb) {
    var options = {
        uuid: serverUuids,
        default: false,
        setup: true,
        status: 'running',
        extras: {
            status: true,
            sysinfo: true,
            memory: true,
            disk: true
        }
    };

    if (typeof (reserved) === 'boolean') {
        options.reserved = reserved;
    }

    if (filterHeadnode) {
        options.headnode = false;
    }

    log.debug(options, 'Searching for servers');

    var start = new Date();

    ModelServer.list(options, function (err, servers) {
        var delta = new Date() - start;
        log.debug('Servers search took ' + delta + ' ms');

        cb(err, servers);
    });
}


function getOpenProvisioningTickets(log, cb) {
    log.debug('Searching for open provisioning tickets');

    var filter = '&(scope=vm)(action=provision)' +
                 '(|(status=active)(status=queued))';

    var start = new Date();

    ModelWaitlist.query(filter, {}, function (err, tickets) {
        var delta = new Date() - start;
        log.debug('Open provisioning tickets search took ' + delta + ' ms');

        cb(err, tickets);
    });
}


function invalid(param, errMsg, res, next) {
    var err = [ {
        param: param,
        msg: errMsg
    } ];

    res.send(500, validation.formatValidationErrors(err));
    next();
}


/*
 * Sometimes ops see allocation failures or disagree with the reasoning that
 * DAPI provided about an allocation. When that happens, it's handy to have a
 * snapshot in the logs of what DAPI saw.
 *
 * This is an out-of-band async function, so it never invokes a callback.
 */

function logResults(log, server, servers, params, tickets, defaults, steps) {
    var json = JSON.stringify({
       serverChosen: server,
       servers: servers,
       params: params,
       tickets: tickets,
       defaults: defaults,
       steps: steps
    });

    return zlib.gzip(json, function (err, gz) {
        if (err)
            return log.error('Error gzipping snapshot JSON for logging');

        // normally this should go under a debug level, but we need this logged
        // despite the default log level of CNAPI being info
        log.info({ snapshot: gz.toString('base64') },
                 'Snapshot of request, results, and reasoning by DAPI');

        return null;
    });
}


function attachTo(http, app) {
    var ensure = require('../endpoints').ensure;

    var endpoints = [
        ['allocate', 'SelectServer'],
        ['capacity', 'ServerCapacity']
    ];

    endpoints.forEach(function (endpoint) {
        var path = endpoint[0];
        var name = endpoint[1];

        http.post({
                path: '/' + path,
                name: name
            },
            ensure({
                connectionTimeoutSeconds: 60 * 60,
                app: app,
                connected: ['moray']
            }),
            function (req, res, next) {
                Allocations[path](req, res, next);
            });
    });
}


exports.attachTo = attachTo;
