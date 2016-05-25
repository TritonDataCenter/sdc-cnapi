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

            plan.reboots = reboots;
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
    if (req.params.name) {
        plan.name = req.params.name;
    }

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
                    if (!p.reboots) {
                        return;
                    }
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
                current_platform: srv.current_platform,
                boot_platform: srv.boot_platform,
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
 * @param {Boolean} single_step optional run just the next plan iteration
 *      and stop until a new request to continue with the plan is made
 * @response 204 None state of the object has been successfully changed.
 * @response 404 Not Found a reboot plan with the provided UUID
 * @response 409 The provided value for 'action' parameter is invalid
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */
RebootPlan.update = function (req, res, next) {
    assert.string(req.params.reboot_plan_uuid, 'reboot_plan_uuid');
    assert.string(req.params.action, 'action');
    assert.optionalBool(req.params.single_step, 'single_step');
    assert.optionalString(req.params.name, 'name');
    var rebootPlan = new ModelRebootPlan(req.params.reboot_plan_uuid);

    function modifyPlan(_, next_) {
        rebootPlan.get(function (error, plan) {
            if (error) {
                req.log.error(error, 'ModelRebootPlan update get error');
                next_(
                    new restify.InternalError(error.message));
                return;
            }

            if (!rebootPlan.exists) {
                next_(new restify.ResourceNotFoundError(sprintf(
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
                next_(new restify.InvalidArgumentError(sprintf(
                            '%s is not a valid action', req.params.action)));
                return;
            }

            // State machine:
            if (req.params.action === 'run' &&
                    (plan.state !== 'created' && plan.state !== 'paused')) {
                next_(new restify.InvalidArgumentError(
                'Only reboot plans with state of created or paused can run'));
                return;
            } else if (req.params.action === 'continue' &&
                    plan.state !== 'paused') {
                next_(new restify.InvalidArgumentError(
                    'Only reboot plans with state of paused can be continued'));
                return;
            } else if (req.params.action === 'stop' &&
                    plan.state !== 'running') {
                next_(new restify.InvalidArgumentError(
                    'Only reboot plans with state of running can be paused'));
                return;
            } else if (req.params.action === 'cancel' &&
                    (plan.state === 'canceled' || plan.state === 'complete')) {
                next_(new restify.InvalidArgumentError(
                    'Cannot cancel already finished plans'));
                return;
            } else if (req.params.action === 'finish' &&
                    plan.state !== 'running') {
                next_(new restify.InvalidArgumentError(
                    'Only reboot plans with state of running can be finished'));
                return;
            }

            function modifyCb(err) {
                if (err) {
                    req.log.error(error, 'ModelRebootPlan modify error');
                    next_(
                        new restify.InternalError(err.message));
                    return;
                }
                res.send(204);
                next_();
                return;
            }

            switch (req.params.action) {
            case 'stop':
                plan.state = 'paused';
                break;
            case 'cancel':
                plan.state = 'canceled';
                break;
            case 'finish':
                plan.state = 'complete';
                break;
            default:
                plan.state = 'running';
                break;
            }

            if (req.params.single_step) {
                plan.single_step = true;
            }

            if (req.params.name) {
                plan.name = req.params.name;
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
                    next_(new restify.InternalError(err.message));
                    return;
                }
                ModelReboot.list({
                    reboot_plan_uuid: plan.uuid
                }, function (err2, reboots) {
                    if (err2) {
                        req.log.error(err2, 'ModelRebootPlan modify error');
                        next_(new restify.InternalError(err2.message));
                        return;
                    }

                    vasync.forEachPipeline({
                        inputs: reboots,
                        func: function cancelReboot(rb, cb) {
                            // Skip already finished reboots:
                            if (rb.state === 'complete' ||
                                rb.state === 'canceled' ||
                                rb.state === 'failed') {
                                cb();
                                return;
                            }
                            var reboot = new ModelReboot(rb.uuid);
                            rb.state = 'canceled';
                            rb.events = [ {
                                type: 'reboot_plan_canceled',
                                time: new Date().toISOString()
                            }];
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
                            next_(new restify.InternalError(pipeErr.message));
                            return;
                        }
                        res.send(204);
                        next_();
                        return;
                    });
                });
            });
        });
    }

    // Make sure we don't allow running two reboot plans at the same time:
    function checkAlreadyRunningPlan(_, next_) {
        if (req.params.action !== 'run' && req.params.action !== 'continue') {
            next_();
            return;
        }
        ModelRebootPlan.list({
            state: 'running'
        }, function (err, plans) {
            if (err) {
                next_(new restify.InternalError(err.message));
                return;
            }

            if (plans && plans.length &&
                    plans[0].uuid !== req.params.reboot_plan_uuid) {
                next_(new restify.InvalidArgumentError(
                            'There\'s another reboot plan (' +
                                plans[0].uuid + ') running'));
                return;
            }
            next_();
            return;
        });
    }

    vasync.pipeline({
        funcs: [checkAlreadyRunningPlan, modifyPlan]
    }, function (pipeErr) {
        if (pipeErr) {
            next(pipeErr);
            return;
        }
        next();
        return;
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
 * @param {String} state string reboot plan state
 * @param {Array} events list of events with timestamps and other arbitrary
 *      information meaningful for each of them
 * @response 204 None state of the object has been successfully changed.
 * @response 404 Not Found a reboot plan with the provided UUID
 * @response 409 The provided values for one or more parameters are invalid
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */

RebootPlan.updateReboot = function (req, res, next) {
    assert.string(req.params.reboot_plan_uuid, 'reboot_plan_uuid');
    assert.string(req.params.reboot_uuid, 'reboot_uuid');
    assert.optionalString(req.params.state, 'state');
    assert.optionalString(req.params.job_uuid, 'job_uuid');


    var rebootPlan = new ModelRebootPlan(req.params.reboot_plan_uuid);
    var reboot = new ModelReboot(req.params.reboot_uuid);

    rebootPlan.get(function (err, plan) {
        if (err) {
            req.log.error(err, 'ModelRebootPlan get error');
            next(
                new restify.InternalError(err.message));
            return;
        }

        req.log.info({
            plan: plan,
            exists: rebootPlan.exists,
            reboot: reboot,
            reboot_exists: reboot.exists
        }, 'Update Reboot Debug');

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
                'state',
                'job_uuid',
                'events',
                'error'
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
 * Get reboot plan's reboot.
 *
 * @name RebootPlanGetReboot
 * @endpoint GET /reboot-plans/:reboot_plan_uuid/reboots/:reboot_uuid
 * @section RebootPlan API
 * @param {String} reboot_plan_uuid UUID of the reboot plan the reboot to
 *      get belongs to.
 * @param {String} reboot_uuid UUID of the reboot to get
 * @response 200 Object reboot
 * @response 404 Not Found a reboot plan with the provided UUID
 * @response 500 None Error while processing request
 */
/* END JSSTYLED */
RebootPlan.getReboot = function (req, res, next) {
    assert.string(req.params.reboot_plan_uuid, 'reboot_plan_uuid');
    assert.string(req.params.reboot_uuid, 'reboot_uuid');

    var rebootPlan = new ModelRebootPlan(req.params.reboot_plan_uuid);
    var reboot = new ModelReboot(req.params.reboot_uuid);

    rebootPlan.get(function (err, plan) {
        if (err) {
            req.log.error(err, 'ModelRebootPlan get error');
            next(
                new restify.InternalError(err.message));
            return;
        }

        req.log.info({
            plan: plan,
            exists: rebootPlan.exists
        }, 'Update Reboot Debug');

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
            res.send(reboot.value);
            next();
            return;
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

    // Get a reboot plan's reboot
    http.get({
        path: '/reboot-plans/:reboot_plan_uuid/reboots/:reboot_uuid',
        name: 'RebootPlanGetReboot'
    }, ensure({
        connectionTimeoutSeconds: 60 * 60,
        app: app,
        connected: ['moray']
    }), RebootPlan.getReboot);

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
