/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * This file contains all the logic used to manage reboot plans.
 * Reboot plans are used to coordinate the reboot of one or more
 * servers, depending on different criteria to group them. A reboot
 * plan will have one or more associated "reboots".
 */

var once = require('once');
var sprintf = require('sprintf').sprintf;
var async = require('async');
var common = require('../common');

var buckets = require('../apis/moray').BUCKETS;
var ModelBase = require('./base');
var ModelReboot = require('./reboot');

function ModelRebootPlan(uuid) {
    if (!uuid) {
        throw new Error('ModelRebootPlan missing uuid parameter');
    }

    this.value = null;
    this.uuid = uuid;

    this.log = ModelRebootPlan.getLog();
}

/**
 *
 * One-time initialization for some things like logs and caching.
 */

ModelRebootPlan.init = function (app) {
    this.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelRebootPlan[p] = ModelBase.staticFn[p];
    });

    ModelRebootPlan.log = app.getLog();
};


/**
 * Returns a copy of the reboot model's internal representation retried from
 * the backend store, or from memory if this object has been previously
 * fetched.
 *
 * @param {Function} callback: of the form f(err, plan)
 */

ModelRebootPlan.prototype.get = function (callback) {
    var self = this;
    var plan;

    if (self.exists === false) {
        this.log.warn(
            '%s was not found previously, returning negative result',
            self.uuid);
        callback();
        return;
    }

    if (self.value) {
        callback(null, self.value);
    } else {
        this.log.trace('Fetching reboot plan %s from moray', self.uuid);
        ModelRebootPlan.getMoray().getObject(
            buckets.reboot_plans.name,
            self.uuid,
            function (error, obj) {
                if (error && error.name === 'ObjectNotFoundError') {
                    self.exists = false;
                    self.log.error('Reboot plan %s not found in moray',
                            self.uuid);

                    callback();
                    return;
                } else if (error) {
                    self.log.error(error,
                            'Error fetching reboot plan from moray');
                    callback(error);
                    return;
                }
                self.found = true;
                self.exists = true;
                plan = obj.value;
                self.value = obj.value;

                callback(null, plan);
            });
    }
};


/**
 * Create a server record in moray.
 */

ModelRebootPlan.prototype.store = function (plan, callback) {
    var self = this;

    var uuid = plan.uuid;

    ModelRebootPlan.getMoray().putObject(
        buckets.reboot_plans.name,
        uuid,
        plan,
        function (error) {
            if (error) {
                self.log.error(error, 'Error adding reboot plan to moray');
                callback(error);
                return;
            }

            callback();
        });
};


/**
 * Modify a reboot plan record.
 */

ModelRebootPlan.prototype.modify = function (plan, callback) {
    var self = this;

    self.value = self.value || {};
    var p;
    for (p in plan) {
        self.value[p] = plan[p];
    }

    self.log.trace({ plan: self.value.uuid },
                   'Writing plan %s to moray', self.value.uuid);

    ModelRebootPlan.getMoray().putObject(
        buckets.reboot_plans.name,
        self.uuid,
        self.value,
        function (error) {
            if (error) {
                self.log.error(error, 'modifying reboot plan');
            }
            callback(error);
        });
};


ModelRebootPlan.prototype.del = function (callback) {
    var self = this;
    self.log.info('Deleting reboot plan %s from moray', self.uuid);
    async.waterfall([
        // Only plan with state "created" or "canceled" can be destroyed,
        // otherwise, we'll keep them for historical reasons
        function validatePlanDidNotRun(cb) {
            if (self.value.state !== 'created' &&
                    self.value.state !== 'canceled') {
                cb(new Error('Can not delete reboot plans ' +
                            'which have run or are running'));
                return;
            }
            cb();
        },
        function deletePlan(cb) {
            ModelRebootPlan.getMoray().delObject(
                buckets.reboot_plans.name,
                self.uuid,
                cb);
        },
        function findPlanReboots(cb) {
            ModelReboot.list({
                reboot_plan_uuid: self.uuid
            }, function (err, reboots) {
                self.log.info(reboots, 'Reboots from findPlanReboots');
                if (err) {
                    cb(err);
                    return;
                }
                cb(null, reboots);
            });
        },
        function delPlanReboots(reboots, cb) {
            self.log.info(reboots, 'Reboots from delPlanReboots');
            var errs = [];
            async.forEachSeries(reboots, function delReboot(r, next) {
                self.log.info(r, 'Reboot from delReboot');
                var reboot = new ModelReboot(r.uuid);
                self.log.info(reboot, 'Reboot instance from delReboot');
                reboot.del(function (err) {
                    if (err) {
                        self.log.error(err, 'Error deleting plan reboot');
                        errs.push(err.message);
                    }
                    next();
                });
            }, function serieCb(err) {
                if (errs.length) {
                    cb(errs.join(', '));
                    return;
                }
                cb();
            });
        }
    ], function (wErr) {
        if (wErr) {
            callback(wErr);
            return;
        }
        callback();
    });

};

/**
 * Return a list of reboot plans matching given criteria.
 *
 * @param {Object} params: List parameters
 *      @params {String} params.filter: Return only plans on the given state.
 *      One of "created", "stopped", "running", "canceled", "complete" or
 *      "pending". Note that pending is an special state which means "not
 *      complete or canceled"
 *      @params {Boolean} params.include_reboots: Include reboots for each
 *      reboot plan retrieved
 * @param {Function} callback: of the form f(error, rebootPlans)
 */

ModelRebootPlan.list = function (params, callback) {
    var self = this;

    callback = once(callback);

    var filter = '(uuid=*)';

    var moray = ModelRebootPlan.getMoray();

    var findOpts = {
        sort: {
            attribute: '_id',
            order: 'DESC'
        }
    };

    ['limit', 'offset'].forEach(function (f) {
        if (params.hasOwnProperty(f)) {
            findOpts[f] = params[f];
        }
    });

    if (params.state) {
        if (params.state === 'pending') {
            filter = '(|(state=created)(state=stopped)(state=running))';
        } else {
            filter = sprintf('(state=%s)', common.filterEscape(params.state));
        }
    }


    function getPlansReboots(plans, cb) {
        async.forEachSeries(plans, function (plan, _next) {
            ModelReboot.list({
                reboot_plan_uuid: plan.uuid
            }, function (error2, reboots) {
                if (error2) {
                    _next(error2);
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
                        canceled_at: r.canceled_at,
                        boot_platform: r.boot_platform,
                        current_platform: r.current_platform,
                        headnode: r.headnode
                    });
                });
                _next();
                return;
            });

        }, function (err) {
            if (err) {
                cb(err);
                return;
            }
            cb(null, plans);
        });
    }

    var rebootPlans = [];

    var req = moray.findObjects(
        buckets.reboot_plans.name,
        filter,
        findOpts);

    req.on('error', function onError(error) {
        self.log.error(error, 'error retrieving reboot plans');
        callback(error);
        return;
    });

    req.on('record', function onRecord(rebootPlan) {
        rebootPlans.push(rebootPlan.value);
    });

    req.on('end', function () {
        if (params.include_reboots) {
            getPlansReboots(rebootPlans, callback);
            return;
        } else {
            callback(null, rebootPlans);
            return;
        }
    });
};

module.exports = ModelRebootPlan;
