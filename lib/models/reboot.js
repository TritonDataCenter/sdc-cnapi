/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * This file contains all the logic used to manage a single server reboot as
 * part of a reboot plan.
 *
 * The reason for having separated reboot model, with one instance per server
 * rebooted is to be able to cope with many servers as part of a reboot plan
 * w/o experiencing issues with Moray backend.
 */

var once = require('once');
var sprintf = require('sprintf').sprintf;

var common = require('../common');

var buckets = require('../apis/moray').BUCKETS;
var ModelBase = require('./base');

/**
 * Reboot a server as part of a reboot plan.
 *
 * At the moment of creating the reboot-plan, a "reboot" entry will be created
 * for each server included into the plan.
 * This will include values for "reboot_plan_uuid", "server_uuid" and
 * "server_hostname".
 *
 * Value for "job_uuid" will be set to the value received by reboot
 * end-point when queueing the reboot job.
 *
 * The reboot job itself will set the values for both, "started_at"
 * and "finished_at".
 */
function ModelReboot(uuid) {
    if (!uuid) {
        throw new Error('ModelReboot missing uuid parameter');
    }

    this.value = null;
    this.uuid = uuid;

    this.log = ModelReboot.getLog();
}

/**
 *
 * One-time initialization for some things like logs and caching.
 */

ModelReboot.init = function (app) {
    this.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelReboot[p] = ModelBase.staticFn[p];
    });

    ModelReboot.log = app.getLog();
};


/**
 * Returns a copy of the reboot model's internal representation retried from
 * the backend store, or from memory if this object has been previously
 * fetched.
 *
 * @param {Function} callback: of the form f(err, reboot)
 */

ModelReboot.prototype.get = function (callback) {
    var self = this;
    var uuid = self.uuid;
    var reboot;

    if (self.exists === false) {
        this.log.warn(
            '%s was not found previously, returning negative result', uuid);
        callback();
        return;
    }

    if (self.value) {
        callback(null, self.value);
    } else {
        this.log.trace('Fetching reboot %s from moray', uuid);
        ModelReboot.getMoray().getObject(
            buckets.reboots.name,
            uuid,
            function (error, obj) {
                if (error && error.name === 'ObjectNotFoundError') {
                    self.exists = false;
                    self.log.error('Reboot %s not found in moray', uuid);

                    callback();
                    return;
                } else if (error) {
                    self.log.error(error, 'Error fetching reboot from moray');
                    callback(error);
                    return;
                }
                self.found = true;
                self.exists = true;
                reboot = obj.value;
                self.value = obj.value;

                callback(null, reboot);
            });
    }
};


/**
 * Create a server record in moray.
 */

ModelReboot.prototype.store = function (reboot, callback) {
    var self = this;

    if (!reboot.reboot_plan_uuid) {
        callback(new Error('ModelReboot missing reboot_plan_uuid parameter'));
        return;
    }

    if (!reboot.server_uuid) {
        callback(new Error('ModelReboot missing server_uuid parameter'));
        return;
    }

    var uuid = reboot.uuid;

    if (!reboot.state) {
        reboot.state = 'created';
    }

    ModelReboot.getMoray().putObject(
        buckets.reboots.name,
        uuid,
        reboot,
        function (error) {
            if (error) {
                self.log.error(error, 'Error adding reboot to moray');
                callback(error);
                return;
            }

            callback();
        });
};


/**
 * Modify a reboot record.
 */

ModelReboot.prototype.modify = function (reboot, callback) {
    var self = this;

    self.value = self.value || {};
    [
        'uuid',
        'reboot_plan_uuid',
        'job_uuid',
        'server_uuid',
        'state',
        'current_platform',
        'boot_platform'
    ].forEach(function (p) {
        if (reboot[p]) {
            self.value[p] = reboot[p];
        }
    });


    if (!self.value.events) {
        self.value.events = [];
    }

    self.value.events = self.value.events.concat(reboot.events);

    self.log.info({ reboot: self.value },
                   'Writing reboot %s to moray', self.value.uuid);

    ModelReboot.getMoray().putObject(
        buckets.reboots.name,
        self.uuid,
        self.value,
        function (error) {
            if (error) {
                self.logerror(error, 'modifying reboot');
            }
            callback(error);
        });
};

/**
 * Delete a reboot record
 */

ModelReboot.prototype.del = function (callback) {
    var self = this;
    ModelReboot.getMoray().delObject(
        buckets.reboots.name,
        self.uuid,
        callback);
};

/**
 * Return a list of reboots matching given criteria.
 */

ModelReboot.list = function (params, callback) {
    var self = this;

    callback = once(callback);

    var filter = '(uuid=*)';

    var moray = ModelReboot.getMoray();

    var findOpts = {
        sort: {
            attribute: '_id',
            order: 'ASC'
        }
    };

    ['limit', 'offset'].forEach(function (f) {
        if (params.hasOwnProperty(f)) {
            findOpts[f] = params[f];
        }
    });

    if (!params.filter) {
        var paramsFilter = [];

        if (params.reboot_plan_uuid) {
            paramsFilter.push(
                    sprintf('(reboot_plan_uuid=%s)',
                        common.filterEscape(params.reboot_plan_uuid)));
        }

        if (paramsFilter.length > 1) {
            filter = sprintf('(&%s(&%s))', filter, paramsFilter.join(''));
        } else {
            filter = sprintf('(&%s)', paramsFilter[0]);
        }
    } else {
        filter = params.filter;
    }

    self.log.info({filter: filter}, 'Reboot list filter');

    var reboots = [];

    var req = moray.findObjects(
        buckets.reboots.name,
        filter,
        findOpts);

    req.on('error', function onError(error) {
        self.log.error(error, 'error retriving reboots');
        callback(error);
        return;
    });

    req.on('record', function onRecord(reboot) {
        reboots.push(reboot.value);
    });

    req.on('end', function () {
        callback(null, reboots);
        return;
    });
};

/*
 * Returns a pending reboot, if exists, for the given server.
 *
 * @param {Function} callback: of the form f(err, reboot)
 */
ModelReboot.pending = function (params, callback) {
    if (!params.server_uuid) {
        callback(new Error('server_uuid is required for ModelReboot.pending'));
        return;
    }

    var filter = sprintf(
            '(&(server_uuid=%s)' +
            '(|(state=created)(state=initiated)(state=rebooting)))',
            params.server_uuid);

    ModelReboot.list({
        filter: filter
    }, function (err, reboots) {
        if (err) {
            callback(err);
            return;
        }

        var reboot = reboots[0] || null;
        callback(null, reboot);
        return;
    });
};

module.exports = ModelReboot;
