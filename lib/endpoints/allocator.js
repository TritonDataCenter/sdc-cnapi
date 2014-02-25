/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoint for selecting a server to allocate to.
 */

var async   = require('async');
var restify = require('restify');

var dapiAlloc = require('dapi/lib/allocator');
var dapiValid = require('dapi/lib/validations');

var ModelServer = require('../models/server');
var validation  = require('../validation/endpoints');


var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

var VALIDATION_RULES = {
    servers:  ['optional', 'isArrayType'],
    package:  ['isObjectType'],
    image:    ['isObjectType'],
    vm:       ['isObjectType'],
    nic_tags: ['isArrayType']
};


function Allocator(algoDesc) {
    this.allocator = new dapiAlloc(ModelServer.log, algoDesc);
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
 * @section Allocation
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

Allocator.prototype.post = function (req, res, next) {
    var self = this;
    var err;

    if (validation.ensureParamsValid(req, res, VALIDATION_RULES)) {
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

    err = dapiValid.validatePackage(pkg);
    if (err) {
        invalid('package', err, res, next);
        return;
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

    var options = {};
    options.wantFinal = true;
    options.uuid = servers;
    options.extras = { status: true, last_heartbeat: true,
                       sysinfo: true, memory: true, vms: true, disk: true };
    options.default = false;

    req.log.debug(options, 'Searching for all servers');

    ModelServer.list(options, function (err2, serverDetails) {
        if (err2) {
            next(new restify.InternalError(err2.message));
            return;
        }

        req.log.debug({ servers: serverDetails },
                      'Servers found, running allocator');

        var results = self.allocator.allocate(serverDetails, vm, img, pkg);
        var server = results[0];
        var stepSummary = results[1];

        req.log.debug({ server: server, steps: stepSummary }, 'Allocator run');

        if (!server) {
            var httpErr = {
                statusCode: 409,
                body: {
                    code: 'InvalidArgument',
                    steps: stepSummary,
                    message: 'No allocatable servers found. Last step was: ' +
                             stepSummary.slice(-1)[0].step
                }
            };

            next(new restify.HttpError(httpErr));
            return;
        }

        res.send({ server: server, steps: stepSummary });
        next();
        return;
    });

    return;
};


function invalid(param, errMsg, res, next) {
    var err = [ {
        param: param,
        msg: errMsg
    } ];

    res.send(500, validation.formatValidationErrors(err));
    next();
}


function attachTo(http, app) {
    var config = app.config.dapi;
    var algoDesc = config.allocationDescription;
    var allocator = new Allocator(algoDesc);

    var post = function (req, res, next) {
        return allocator.post(req, res, next);
    };

    var ensure = require('../endpoints').ensure;

    http.post(
        { path: '/allocate', name: 'SelectServer' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray']
        }),
        post);
}


exports.attachTo = attachTo;
