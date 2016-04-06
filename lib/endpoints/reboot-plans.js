/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */


/**
 * HTTP End-points for interacting with Reboot Plans
 */

var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var verror = require('verror');
var assert = require('assert-plus');
var async = require('async');
var vasync = require('vasync');

var common = require('../common');
var ModelRebootPlan = require('../models/reboot-plan');
var ModelReboot = require('../models/reboot');
var ModelServer = require('../models/server');

var RebootPlan = {};

RebootPlan.init = function (app) {
    ModelRebootPlan.init(app);
    ModelReboot.init(app);
    RebootPlan.log = ModelRebootPlan.log;
};


/* BEGIN JSSTYLED */
/**
 * List reboot plans.
 *
 * @name RebootPlanList
 * @endpoint GET /reboot-plans
 * @section RebootPlan API
 * @param {String} state Desired state of the reboot plans to retrieve
 * @response 200 Object list of reboot plans.
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */


RebootPlan.list = function (req, res, next) {
    var options = {};

    ['state', 'include_reboots', 'limit', 'offset'].forEach(function (f) {
        if (req.params.hasOwnProperty(f)) {
            options[f] = req.params[f];
        }
    });

    ModelRebootPlan.list(options, function (error, plans) {
        if (error) {
            req.log.error(error, 'ModelRebootPlan list error');
            next(
                new restify.InternalError(error.message));
            return;
        }
        res.send(200, plans);
        next();
        return;
    });
};


/* BEGIN JSSTYLED */
/**
 * Get a reboot plan by UUID.
 *
 * @name RebootPlanGet
 * @endpoint GET /reboot-plans/:reboot_plan_uuid
 * @section RebootPlan API
 * @param {String} reboot_plan_uuid UUID of the reboot plan to retrieve
 * @response 200 Object reboot plan.
 * @response 404 Not Found a reboot plan with the provided UUID
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */
RebootPlan.get = function (req, res, next) {
    assert.string(req.params.reboot_plan_uuid, 'reboot_plan_uuid');

    var rebootPlan = new ModelRebootPlan(req.params.reboot_plan_uuid);
    rebootPlan.get(function (error, plan) {

        if (error) {
            req.log.error(error, 'ModelRebootPlan get error');
            next(
                new restify.InternalError(error.message));
            return;
        }

        if (!rebootPlan.exists) {
            next(new restify.ResourceNotFoundError(sprintf(
                'Reboot plan with uuid %s does not exist',
                req.params.reboot_plan_uuid)));
            return;
        }

        ModelReboot.list({
            reboot_plan_uuid: req.params.reboot_plan_uuid
        }, function (error2, reboots) {
            if (error2) {
                req.log.error(error2, 'ModelRebootPlan get error');
                next(
                    new restify.InternalError(error2.message));
                return;
            }

            plan.reboots = reboots.map(function (r) {
                return ({
                    server_uuid: r.server_uuid,
                    server_hostname: r.server_hostname,
                    job_uuid: r.job_uuid,
                    started_at: r.started_at,
                    finished_at: r.finished_at,
                    operational_at: r.operational_at,
                    boot_platform: r.boot_platform,
                    current_platform: r.current_platform,
                    headnode: r.headnode
                });
            });
            res.send(200, plan);
            next();
        });
    });
};



/* BEGIN JSSTYLED */
/**
 * Create reboot plans.
 *
 * @name RebootPlanCreate
 * @endpoint POST /reboot-plans
 * @section RebootPlan API
 * @param {Integer} concurrency Number of servers to reboot simultaneously
 * @param {Object} servers Array of UUIDs of the servers to reboot
 * @response 201 String UUID of the reboot plan created.
 * @response 409 Error invalid arguments. Either the provided servers UUIDs
 *      are not valid or there are one or more pending reboot plans involving
 *      one or more servers added to the current reboot plan.
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */
RebootPlan.create = function (req, res, next) {
    var plan = {};
    /* BEGIN JSSTYLED */
    var uuids;
    if (Array.isArray(req.params.servers)) {
        uuids = req.params.servers;
    } else {
        uuids = req.params.servers &&
                req.params.servers.split(/\s*,\s*/g);
    }
    /* END JSSTYLED */

    if (!uuids || !uuids.length) {
        next(new restify.MissingParameterError('servers are required'));
        return;
    }

    plan.concurrency = req.params.concurrency || 5;
    plan.uuid = common.genId();
    plan.state = 'created';
    plan.single_step = false;

    var servers;

    function validateUids(cb) {
        ModelServer.list({
            uuid: uuids
        }, function (sError, s) {
            if (sError) {
                req.log.error(sError, 'ModelServer list error');
                cb(
                    new restify.InternalError(sError.message));
                return;
            }
            req.log.debug({ servers: s }, 'Servers found');

            // Given some invalid UUIDs, let's complain about it:
            if (s.length !== uuids.length) {
                var sUuids = s.map(function (srv) {
                    return (srv.uuid);
                });

                var invalidUuids = [];
                uuids.forEach(function (u) {
                    if (sUuids.indexOf(u) === -1) {
                        invalidUuids.push(u);
                    }
                });

                if (invalidUuids.lenght) {
                    cb(new restify.InvalidArgumentError(
                        'The following servers are not valid: ' +
                        invalidUuids.join(',')));
                    return;
                }
            }

            servers = s;
            cb();
            return;
        });
    }

    function verifyNoPendingRebootPlans(cb) {
        ModelRebootPlan.list({
            state: 'pending',
            includeReboots: true
        }, function (err, plans) {
            if (err) {
                cb(err);
                return;
            }

            if (plans.length) {
                var serversToBeRebooted = [];
                plans.forEach(function (p) {
                    p.reboots.forEach(function (r) {
                        if (serversToBeRebooted.indexOf(r.server_uuid) === -1) {
                            serversToBeRebooted.push(r.server_uuid);
                        }
                    });
                });

                var invalidUuids = [];
                uuids.forEach(function (u) {
                    if (serversToBeRebooted.indexOf(u) === -1) {
                        invalidUuids.push(u);
                    }
                });

                if (invalidUuids.lenght) {
                    cb(new restify.InvalidArgumentError(
                        'The following servers have pending reboots: ' +
                        invalidUuids.join(',')));
                    return;
                }
            }

            cb();
            return;
        });
    }


    function storeRebootPlan(cb) {
        var rebootPlan = new ModelRebootPlan(plan.uuid);

        rebootPlan.store(plan, function (error) {
            if (error) {
                req.log.error(error, 'ModelRebootPlan store error');
                cb(
                    new restify.InternalError(error.message));
                return;
            }
            req.log.debug({ plan: plan }, 'Reboot Plan created');
            cb();
            return;
        });
    }

    function storeReboots(cb) {
        var errs = [];

        var queue = async.queue(function worker(reboot, cb_) {
            var r = new ModelReboot(reboot.uuid);
            r.store(reboot, function (err) {
                if (err) {
                    req.log.error(err, 'ModelReboot store error');
                    errs.push(err.message);
                }
                cb_();
            });
        }, 5);

        queue.drain = function () {
            if (errs.length) {
                cb(new restify.InternalError(errs.join(',')));
                return;
            }
            cb();
            return;
        };

        servers.forEach(function (srv) {
            queue.push({
                server_uuid: srv.uuid,
                server_hostname: srv.hostname,
                current_platform: srv.current_platform,
                boot_platform: srv.boot_platform,
                headnode: srv.headnode,
                reboot_plan_uuid: plan.uuid,
                uuid: common.genId()
            });
        });
    }

    async.waterfall([
        validateUids,
        verifyNoPendingRebootPlans,
        storeReboots,
        storeRebootPlan
    ], function (wErr) {
        if (wErr) {
            next(wErr);
            return;
        }
        res.send(201, {uuid: plan.uuid});
        next();
    });
};


/* BEGIN JSSTYLED */
/**
 * Update reboot plan.
 *
 * @name RebootPlanUpdate
 * @endpoint PUT /reboot-plans/:reboot_plan_uuid
 * @section RebootPlan API
 * @param {String} reboot_plan_uuid UUID of the reboot plan to update
 * @param {String} action one of "run", "stop", "continue", "cancel".
 *      ("next" when step based execution is implemented)
 * @response 204 None state of the object has been successfully changed.
 * @response 404 Not Found a reboot plan with the provided UUID
 * @response 409 The provided value for 'action' parameter is invalid
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */
RebootPlan.update = function (req, res, next) {
    assert.string(req.params.reboot_plan_uuid, 'reboot_plan_uuid');
    assert.string(req.params.action, 'action');
    assert.optionalString(req.params.single_step, 'single_step');
    var rebootPlan = new ModelRebootPlan(req.params.reboot_plan_uuid);

    rebootPlan.get(function (error, plan) {
        if (error) {
            req.log.error(error, 'ModelRebootPlan update get error');
            next(
                new restify.InternalError(error.message));
            return;
        }

        if (!rebootPlan.exists) {
            next(new restify.ResourceNotFoundError(sprintf(
                'Reboot plan with uuid "%s" does not exist',
                req.params.reboot_plan_uuid)));
            return;
        }

        if (['run',
            'stop',
            'continue',
            'cancel',
            'finish'
        ].indexOf(req.params.action) === -1) {
            next(new restify.InvalidArgumentError(sprintf(
                        '%s is not a valid action', req.params.action)));
            return;
        }

        // State machine:
        if (req.params.action === 'run' &&
                (plan.state !== 'created' && plan.state !== 'stopped')) {
            next(new restify.InvalidArgumentError(
                'Only reboot plans with state of created or stopped can run'));
            return;
        } else if (req.params.action === 'continue' &&
                plan.state !== 'stopped') {
            next(new restify.InvalidArgumentError(
                'Only reboot plans with state of stopped can be continued'));
            return;
        } else if (req.params.action === 'stop' && plan.state !== 'running') {
            next(new restify.InvalidArgumentError(
                'Only reboot plans with state of running can be stopped'));
            return;
        } else if (req.params.action === 'cancel' &&
                (plan.state === 'canceled' || plan.state === 'complete')) {
            next(new restify.InvalidArgumentError(
                'Cannot cancel already finished plans'));
            return;
        } else if (req.params.action === 'finish' && plan.state !== 'running') {
            next(new restify.InvalidArgumentError(
                'Only reboot plans with state of running can be finished'));
            return;
        }

        function modifyCb(err) {
            if (err) {
                req.log.error(error, 'ModelRebootPlan modify error');
                next(
                    new restify.InternalError(err.message));
                return;
            }
            res.send(204);
            next();
            return;
        }

        switch (req.params.action) {
        case 'stop':
            plan.state = 'stopped';
            break;
        case 'cancel':
            plan.state = 'canceled';
            break;
        default:
            plan.state = 'running';
            break;
        }

        if (req.params.single_step) {
            plan.single_step = true;
        }

        if (req.params.action !== 'cancel') {
            rebootPlan.modify(plan, modifyCb);
            return;
        }
        // If we're cancelling a reboot plan, we also want to cancel all the
        // reboots in a way those will not be pending when we're looking for
        // reboots for a given server:
        rebootPlan.modify(plan, function (err) {
            if (err) {
                req.log.error(error, 'ModelRebootPlan modify error');
                next(new restify.InternalError(err.message));
                return;
            }
            ModelReboot.list({
                reboot_plan_uuid: plan.uuid
            }, function (err2, reboots) {
                if (err2) {
                    req.log.error(err2, 'ModelRebootPlan modify error');
                    next(new restify.InternalError(err2.message));
                    return;
                }

                vasync.forEachPipeline({
                    inputs: reboots,
                    func: function cancelReboot(rb, cb) {
                        // Skip already finished reboots:
                        if (rb.operational_at) {
                            cb();
                            return;
                        }
                        var reboot = new ModelReboot(rb.uuid);
                        rb.canceled_at = new Date().toISOString();
                        reboot.modify(rb, function (modError) {
                            if (modError) {
                                req.log.error(modError,
                                        'ModelReboot modify error');
                                cb(modError);
                                return;
                            }
                            cb();
                            return;
                        });
                    }
                }, function pipeCb(pipeErr) {
                    if (pipeErr) {
                        next(new restify.InternalError(pipeErr.message));
                        return;
                    }
                    res.send(204);
                    next();
                    return;
                });
            });
        });
    });
};

/* BEGIN JSSTYLED */
/**
 * Update reboot plan's reboot.
 *
 * @name RebootPlanUpdateReboot
 * @endpoint PUT /reboot-plans/:reboot_plan_uuid/reboots/:reboot_uuid
 * @section RebootPlan API
 * @param {String} reboot_plan_uuid UUID of the reboot plan the reboot to
 *      update belongs to.
 * @param {String} reboot_uuid UUID of the reboot to update
 * @param {String} job_uuid UUID of the reboot job
 * @param {String} started_at ISO 8601 formatted Date string
 * @param {String} finished_at ISO 8601 formatted Date string
 * @response 204 None state of the object has been successfully changed.
 * @response 404 Not Found a reboot plan with the provided UUID
 * @response 409 The provided values for one or more parameters are invalid
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

RebootPlan.updateReboot = function (req, res, next) {
    assert.string(req.params.reboot_plan_uuid, 'reboot_plan_uuid');
    assert.string(req.params.reboot_uuid, 'reboot_uuid');

    assert.optionalString(req.params.started_at, 'started_at');
    assert.optionalString(req.params.finished_at, 'finished_at');
    assert.optionalString(req.params.job_uuid, 'job_uuid');

    assert.optionalString(req.params.operational_at, 'operational_at');

    var rebootPlan = new ModelRebootPlan(req.params.reboot_plan_uuid);
    var reboot = new ModelReboot(req.params.reboot_uuid);

    if (req.params.started_at && isNaN(Date.parse(req.params.started_at))) {
        next(new restify.InvalidArgumentError(
                'started_at must be a valid ISO 8601 Date string'));
        return;
    }

    if (req.params.finished_at && isNaN(Date.parse(req.params.finished_at))) {
        next(new restify.InvalidArgumentError(
                'finished_at must be a valid ISO 8601 Date string'));
        return;
    }

    if (req.params.operational_at &&
            isNaN(Date.parse(req.params.operational_at))) {
        next(new restify.InvalidArgumentError(
                'operational_at must be a valid ISO 8601 Date string'));
        return;
    }

    rebootPlan.get(function (err, plan) {
        if (err) {
            req.log.error(err, 'ModelRebootPlan get error');
            next(
                new restify.InternalError(err.message));
            return;
        }

        if (!rebootPlan.exists) {
            next(new restify.ResourceNotFoundError(sprintf(
                'Reboot plan with uuid %s does not exist',
                req.params.reboot_plan_uuid)));
            return;
        }

        reboot.get(function (error, r) {
            if (error) {
                req.log.error(error, 'ModelReboot get error');
                next(
                    new restify.InternalError(error.message));
                return;
            }

            if (!reboot.exists) {
                next(new restify.ResourceNotFoundError(sprintf(
                    'Reboot with uuid %s does not exist',
                    req.params.reboot_uuid)));
                return;
            }

            [
                'operational_at',
                'started_at',
                'finished_at',
                'job_uuid'
            ].forEach(function (p) {
                if (req.params[p]) {
                    reboot[p] = req.params[p];
                }
            });

            reboot.modify(reboot, function (modError) {
                if (modError) {
                    req.log.error(modError, 'ModelReboot modify error');
                    next(
                        new restify.InternalError(modError.message));
                    return;
                }
                res.send(204);
                next();
                return;
            });
        });
    });

};

/* BEGIN JSSTYLED */
/**
 * Remove all references to given reboot plan, including associated reboots.
 *
 * @name RebootPlanDelete
 * @endpoint DELETE /reboot-plans/:reboot_plan_uuid
 * @section RebootPlan API
 *
 * @response 204 None Reboot plan was deleted successfully
 * @response 404 Not Found a reboot plan with the provided UUID
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */
RebootPlan.del = function (req, res, next) {
    assert.string(req.params.reboot_plan_uuid, 'reboot_plan_uuid');
    var rebootPlan = new ModelRebootPlan(req.params.reboot_plan_uuid);

    rebootPlan.get(function (error, plan) {
        if (error) {
            req.log.error(error, 'ModelRebootPlan delete get error');
            next(
                new restify.InternalError(error.message));
            return;
        }

        if (!rebootPlan.exists) {
            next(new restify.ResourceNotFoundError(sprintf(
                'Reboot plan with uuid "%s" does not exist',
                req.params.reboot_plan_uuid)));
            return;
        }

        rebootPlan.del(function (err) {
            if (err) {
                req.log.error(err, 'ModelRebootPlan delete error');
                next(
                    new restify.InternalError(err.message));
                return;
            }
            res.send(204);
            next();
        });
    });
};




function attachTo(http, app) {
    RebootPlan.init(app);

    var ensure = require('../endpoints').ensure;

    // List reboot plans
    http.get(
        { path: '/reboot-plans', name: 'RebootPlanList' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray']
        }),
        RebootPlan.list);

    // Get reboot plan
    http.get(
        { path: '/reboot-plans/:reboot_plan_uuid', name: 'RebootPlanGet' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray']
        }),
        RebootPlan.get);

    // Update reboot plan
    http.put(
        { path: '/reboot-plans/:reboot_plan_uuid', name: 'RebootPlanUpdate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray']
        }),
        RebootPlan.update);

    // Update reboot plan's reboot
    http.put({
        path: '/reboot-plans/:reboot_plan_uuid/reboots/:reboot_uuid',
        name: 'RebootPlanUpdateReboot'
    }, ensure({
        connectionTimeoutSeconds: 60 * 60,
        app: app,
        connected: ['moray']
    }), RebootPlan.updateReboot);

    // Delete server
    http.del(
        { path: '/reboot-plans/:reboot_plan_uuid', name: 'RebootPlanDelete' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray']
        }),
        RebootPlan.del);

    // Create reboot plan
    http.post(
        { path: '/reboot-plans', name: 'RebootPlanCreate' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            connected: ['moray']
        }),
        RebootPlan.create);
}


exports.attachTo = attachTo;
