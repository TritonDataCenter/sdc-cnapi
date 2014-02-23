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


function Allocator(algoDesc) {
    this.allocator = new dapiAlloc(ModelServer.log, algoDesc);
}


/*
 * Returns a server chosen to allocate a new VM, as well as the steps taken to
 * reach that decision. It can also return an error if no server was eligible,
 * given the constraints in the request.
 *
 */

Allocator.prototype.post = function (req, res, next) {
    var self = this;
    var params = req.params;
    var err;

    var missing = function (name) {
        next(new restify.MissingParameterError('"' + name + '" is required'));
    };

    var invalid = function (errMsg) {
        next(new restify.InvalidArgumentError(errMsg));
    };

    var servers = params.servers;
    var img     = params.image;
    var pkg     = params.package;
    var vm      = params.vm;
    var tags    = params.nic_tags;

    if (!pkg)
        return missing('package');

    if (!img)
        return missing('image');

    if (!vm)
        return missing('vm');

    if (!tags)
        return missing('nic_tags');

    err = dapiValid.validateImage(img);
    if (err)
        return invalid(err);

    err = dapiValid.validatePackage(pkg);
    if (err)
        return invalid(err);

    var requirements = params.image.requirements;
    err = dapiValid.validateVmPayload(vm, requirements);
    if (err)
        return invalid(err);

    if (servers && Array.isArray(servers)) {
        for (var i = 0; i !== servers.length; i++) {
            if (!UUID_RE.test(servers[i]))
                return invalid('invalid server UUID');
        }
    }

    if (!Array.isArray(tags))
        return invalid('invalid nic_tags');

    vm.nic_tags = tags;

    var options = {};
    options.wantFinal = true;
    options.uuid = servers;
    options.extras = { status: true, last_heartbeat: true,
                       sysinfo: true, memory: true, vms: true, disk: true };
    options.default = false;

    req.log.debug(options, 'Searching for all servers');

    ModelServer.list(options, function (err2, serverDetails) {
        if (err2)
            return next(new restify.InternalError(err2.message));

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

            return next(new restify.HttpError(httpErr));
        }

        res.send({ server: server, steps: stepSummary });
        return next();
    });

    return null; // make jslint happy
};


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
