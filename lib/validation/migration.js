/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Overview: HTTP migration endpoint validation.
 */

var validation = require('./endpoints');


var vmMigrationRules = {
    jobid: ['optional', 'isStringType'],
    migrationTask: ['isObjectType'],
    uuid: ['isStringType'],
    'migrationTask.action': ['isStringType'],
    'migrationTask.record': ['isObjectType']
};
var migrationTaskRules = {
};


/**
 * Validate that the action requested is valid for the vm migration state.
 */
function validateReq(req, res) {
    if (validation.ensureParamsValid(req, res, vmMigrationRules)) {
        return false;
    }

    return true;
}

module.exports = {
    validateReq: validateReq
};
