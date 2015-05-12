/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * DAPI (allocator) endpoints. The main HTTP endpoint (/allocate) picks a server
 * where to place a new VM. Another endpoint (/capacity) returns how much spare
 * space there is on a set of servers.
 */

var async   = require('async');
var restify = require('restify');
var zlib    = require('zlib');

var dapiAlloc = require('dapi/lib/allocator');
var dapiValid = require('dapi/lib/validations');

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
    nic_tags: ['isArrayType']
};

var CAPACITY_VALIDATION_RULES = {
    servers:  ['optional', 'isArrayType']
};

var DEFAULT_SERVER_SPREAD        = 'min-ram';
var DEFAULT_FILTER_HEADNODE      = true;
var DEFAULT_FILTER_MIN_RESOURCES = true;
var DEFAULT_FILTER_LARGE_SERVERS = true;


function Allocator(algoDesc, changeDefaults) {
    this.defaults = getDefaults(changeDefaults);
    this.allocator = new dapiAlloc(ModelServer.log, algoDesc, this.defaults);
}


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

Allocator.prototype.allocate = function (req, res, next) {
    var self = this;
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
    var tags    = params.nic_tags;

    err = dapiValid.validateImage(img);
    if (err) {
        invalid('image', err, res, next);
        return;
    }

    if (pkg) {
        err = dapiValid.validatePackage(pkg);
        if (err) {
            invalid('package', err, res, next);
            return;
        }
    }

    var requirements = params.image.requirements;
    err = dapiValid.validateVmPayload(vm, requirements);
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

    for (i = 0; i !== tags.length; i++) {
        if (typeof (tags[i]) !== 'string') {
            invalid('nic_tags', 'invalid nic_tag', res, next);
            return;
        }
    }

    vm.nic_tags = tags;

    var httpBody;
    var imgapiPeers = [];
    var serverDetails;
    var tickets;

    async.series([
        function getAllServers(cb) {
            getServers(servers, req.log, function (err2, _serverDetails) {
                if (err2) {
                    cb(new restify.InternalError(err2.message));
                    return;
                }

                serverDetails = _serverDetails;
                cb();
            });
        },

        function getOpenTickets(cb) {
            req.log.debug({ servers: serverDetails },
                      'Servers found, fetching tickets...');

            getOpenProvisioningTickets(req.log, function (err3, _tickets) {
                if (err3) {
                    cb(new restify.InternalError(err3.message));
                    return;
                }

                tickets = _tickets;
                cb();
            });
        },

        function allocateToServer(cb) {
            req.log.debug({ tickets: tickets },
                          'Tickets found, running allocator...');

            var startTime = new Date();
            var results = self.allocator.allocate(serverDetails, vm, img, pkg,
                                                  tickets);
            var server = results[0];
            var stepSummary = results[1];
            var deltaTime = new Date() - startTime;

            req.log.debug('Allocator run took ' + deltaTime + ' ms');
            req.log.debug(httpBody, 'Allocator run');
            logResults(req.log, server, serverDetails, req.params, tickets,
                       this.defaults, stepSummary);

            httpBody = {
                server: server,
                steps: stepSummary
            };

            // XXX we need a better way of determining which step in particular
            // we were on when the sequence came to an end
            var VOLUMES_MSG =
                'Servers containing VMs required for volumes-from';

            if (!server && stepSummary.slice(-1)[0].step === VOLUMES_MSG) {
                cb(new errors.VolumeServerNoResourcesError());
                return;
            }

            if (!server) {
                cb(new errors.NoAllocatableServersError());
                return;
            }

            cb();
        },

        // Get available IMGAPI peers (cn-agents) that can provide this server
        // with the image file if it doesn't have it. Three possible situations:
        // - imgapiPeers is [] if no server has the image
        // - imgapiPeers is null (i.e. not neeeded) if the server has the image
        // - imgapiPeers is an array of peers if other servers have the image
        //
        function getImgapiPeers(cb) {
            var hasImage = false;
            var server = httpBody.server;

            // Prevent this for generating an allocation error. No async
            // executions inside the try/catch
            try {
                if (server.images !== undefined) {
                    server.images.forEach(function (im) {
                        if (im.uuid === img.uuid) {
                            hasImage = true;
                        }
                    });
                }

                if (hasImage) {
                    imgapiPeers = null;
                    cb();
                    return;
                }

                serverDetails.forEach(function (s) {
                    var adminIp = common.getAdminIp(s.sysinfo);

                    if (!adminIp || s.images === undefined ||
                        !s.images.length) {
                        return;
                    }

                    s.images.forEach(function (im) {
                        if (im.uuid === img.uuid) {
                            imgapiPeers.push({
                                ip: adminIp,
                                uuid: s.uuid
                            });
                        }
                    });
                });
            } catch (peerErr) {
                req.log.error(peerErr,
                    'Unexpected error running getImgapiPeers');
            }

            imgapiPeers = imgapiPeers.slice(0, 3);
            cb();
        }

    ], function (asyncErr) {
        if (asyncErr) {
            next(asyncErr);
            return;
        }

        httpBody.imgapiPeers = imgapiPeers;
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

Allocator.prototype.capacity = function (req, res, next) {
    var self = this;

    if (validation.ensureParamsValid(req, res, CAPACITY_VALIDATION_RULES)) {
        next();
        return;
    }

    var servers = req.params.servers;

    if (servers) {
        for (var i = 0; i !== servers.length; i++) {
            if (!UUID_RE.test(servers[i])) {
                invalid('servers', 'invalid server UUID', res, next);
                return;
            }
        }
    }

    getServers(servers, req.log, function (err2, serverDetails) {
        if (err2) {
            next(new restify.InternalError(err2.message));
            return;
        }

        req.log.debug({ servers: serverDetails },
                      'Servers found, running capacity');

        var results = self.allocator.serverCapacity(serverDetails);

        var httpBody = {
            capacities: results[0],
            errors: results[1]
        };

        req.log.debug(httpBody, 'Capacity run');

        res.send(httpBody);
        next();
        return;
    });

    return;
};


function getDefaults(changeDefaults) {
    var defaults = {};

    function setDefault(attr, deflt) {
        var opt = changeDefaults[attr];

        if (opt === '' || !opt) {
            defaults[attr] = deflt;
        } else if (opt === 'true') {
            defaults[attr] = true;
        } else if (opt === 'false') {
            defaults[attr] = false;
        } else {
            defaults[attr] = opt;
        }
    }

    setDefault('server_spread', DEFAULT_SERVER_SPREAD);
    setDefault('filter_headnode', DEFAULT_FILTER_HEADNODE);
    setDefault('filter_min_resources', DEFAULT_FILTER_MIN_RESOURCES);
    setDefault('filter_large_servers', DEFAULT_FILTER_LARGE_SERVERS);
    setDefault('filter_vm_limit');

    return defaults;
}


function getServers(serverUuids, log, cb) {
    var options = {
        wantFinal: true,
        uuid: serverUuids,
        default: false,
        extras: {
            status: true,
            sysinfo: true,
            memory: true,
            vms: true,
            disk: true
        }
    };

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

    ModelWaitlist.query(filter, null, function (err, tickets) {
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
    var config = app.config.dapi;
    var allocator = new Allocator(config.allocationDescription,
                                  config.changeDefaults);

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
                allocator[path](req, res, next);
            });
    });
}


exports.attachTo = attachTo;
