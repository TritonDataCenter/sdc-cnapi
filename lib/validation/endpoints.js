/*
 * Copyright 2020, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints validation routines.
 *
 */

const path = require('path');
const util = require('util');

const restify = require('restify');
const restify_validator = require('restify-validator');
const sprintf = require('sprintf').sprintf;
const VError = require('verror');

// Restcode = InvalidParameters

// Types of errors:
// ErrorInvalidType
// ErrorInvalidValue
// Error
function formatValidationErrors(validationErrors) {
    return {
        code: 'InvalidParameters',
        message: 'Request parameters failed validation',
        errors: validationErrors.map(function (e) {
            return {
                field: e.param,
                code: 'Invalid',
                message: e.msg
            };
        })
    };
}

/**
 * We will monkey patch validator objects so that we can validate non-string
 * values as well.
 */

restify_validator.Validator.prototype.assert =
restify_validator.Validator.prototype.validate =
restify_validator.Validator.prototype.check = function (str, fail_msg) {
    this.str = str;
    this.msg = fail_msg;
    this._errors = this._errors || [];
    return this;
};

function ensureParamsValid(req, res, paramRules, opts) {
    var params = opts && opts.params || req.params;
    var rule;
    var skip = false;

    opts = opts || {};

    if (opts.strict) {
        for (var param in params) {
            if (!paramRules.hasOwnProperty(param)) {
                var error = new restify.InvalidArgumentError(
                    param + ' is not an explicitly defined parameter');
                res.send(409, error);
                return error;
            }
        }
    }

    for (var paramName in paramRules) {
        var assertion = null;

        for (var ruleIdx in paramRules[paramName]) {
            rule = paramRules[paramName][ruleIdx];
            var ruleName;

            if (global.toString.call(rule) === '[object String]') {
                ruleName = rule;
                rule = [ruleName];
            } else if (Array.isArray(rule)) {
                ruleName = rule[0];
            }

            if (!ruleName) {
                throw new Error('ruleName was not');
            }

            var sanitize;

            switch (ruleName) {
                case 'optional':
                    if (Number(ruleIdx) !== 0) {
                        throw new VError(
                            'Rule \'optional\' first must be'
                            + ' first rule specified ruleIdx (%s)',
                            ruleIdx);
                    }

                    if (!params.hasOwnProperty(paramName) ||
                        params[paramName] === undefined) {
                        skip = true;
                        params[paramName] = rule[1];
                        break;
                    }
                    break;

                case 'sanitize':
                    if (!sanitize) {
                        sanitize = req.sanitize(paramName);
                    }

                    sanitize[rule[1]]();
                    break;

                default:
                    break;
            }

            if (skip) {
                skip = false;
                break;
            }


            if (!skip && (ruleName === 'optional' || ruleName === 'sanitize')) {
                continue;
            }

            if (!assertion) {
                assertion = req.assert(
                    paramName,
                    sprintf('Invalid value for param \'%s\'', paramName));

                assertion.isObjectType = function () {
                    var type = Object.prototype.toString.call(this.str);
                    if (type !== '[object Object]') {
                        this.error(
                           'value is not an object. (was: ' + type + ')');
                    }
                    return this;
                };

                assertion.isStringType = function () {
                    var type = Object.prototype.toString.call(this.str);
                    if (type !== '[object String]') {
                        this.error('value was not a string');
                    }
                    return this;
                };

                assertion.isArrayType = function () {
                    if (!Array.isArray(this.str)) {
                        this.error('value was not an array');
                    }
                    return this;
                };

                assertion.isNumberType = function () {
                    if (isNaN(this.str)) {
                        this.error('value was not a number');
                    }
                    return this;
                };

                assertion.isNotEmptyStringType = function () {
                    if (isNaN(this.str)) {
                        this.error('value was not a string');
                        return this;
                    }

                    if (this.str === '') {
                        this.error('value empty string');
                    }
                    return this;
                };

                assertion.isNumberGreaterThanEqualZeroType = function () {
                    if (isNaN(this.str)) {
                        this.error('value was not a number');
                        return this;
                    }

                    if (this.str < 0) {
                        this.error(
                            'value was not greater than or equal to zero');
                    }
                    return this;
                };

                assertion.isNumberOrStringType = function () {
                    if (!isNaN(this.str)) {
                        return this;
                    }
                    var type = Object.prototype.toString.call(this.str);
                    if (type !== '[object String]') {
                        this.error('value was not a number or string');
                    }
                    return this;
                };

                assertion.isTrim = function () {
                    if ((this.str + '').match(/^\s+|\s+$/)) {
                        this.error(
                            'value contains leading or trailing whitespace');
                    }
                    return this;
                };


                assertion.isBooleanType = function () {
                    if (this.str !== true && this.str !== false) {
                        this.error('value was not true or false');
                    }
                    return this;
                };

                assertion.isBooleanString = function () {
                    if (!(this.str + '').match(/^(true|false)$/i)) {
                        this.error('value was not \'true\' or \'false\'');
                    }
                    return this;
                };
            }

            if (!assertion[ruleName]) {
                throw new VError('Unknown rule: %s', ruleName);
            }

            assertion[ruleName].apply(assertion, rule.slice(1));
        }
    }
    var errors = req.validationErrors();
    if (errors) {
        errors = formatValidationErrors(errors);
        res.send(
            500,
            errors);
        return errors;
    }

    return null;
}

function updateLimitedToInternalMetadata(req, res, name) {
    if (req.params.hasOwnProperty('update')) {
        var keys = Object.keys(req.params.update);
        if (keys.length !== 1 || keys[0] !== 'set_internal_metadata') {
            res.send(
                500,
                new restify.InvalidArgumentError(
                    'Vm.%s update param only allows set_internal_metadata, '
                    + 'received: [%s]', name, keys));
            return true;
       }
    }
    return null;
}

/*
 * Expected boot modules format is as follows:
 *
 * {
 *      "path": "boot module path to be used by booter",
 *      "type": "Content type. Right now only base64 is supported",
 *      "content": "File contents, if necessary encoded as specified by type"
 * }
 *
 * In the future, support for new content types or additional members for
 * the boot_module objects could be provided, defaulting to base64.
 */
function validateBootModules(boot_modules) {
    var errs = [];
    var i;
    for (i = 0; i < boot_modules.length; i += 1) {
        var bm = boot_modules[i];
        bm.type = bm.type || 'base64';

        if (bm.type !== 'base64') {
            errs.push(util.format(
                'Unsupported type %s for module \'%s\'', bm.type, bm.path));
            continue;
        }

        if (!bm.path || !bm.content) {
            errs.push(util.format(
                'Unexpected format for boot_module: %j', bm));
            continue;
        }

        if (path.normalize(bm.path) !== bm.path) {
            errs.push(util.format(
                'Invalid path for boot_module: \'%s\' ' +
                '(path cannot contain \'.\' or \'..\')', bm.path));
            continue;
        }

        if (Buffer.byteLength(bm.content, 'base64') > 4 * 1024) {
            errs.push(util.format(
                'Module \'%s\' exceeds the maximum allowed size of 4KB',
                bm.path));
            continue;
        }

        if (Buffer.from(bm.content, 'base64').toString('base64') !==
            bm.content) {
            errs.push(util.format(
                'Contents for module \'%s\' must be base64 encoded', bm.path));
            continue;
        }
    }

    if (errs.length) {
        var err = new restify.InvalidArgumentError(
            'Values provided for boot_modules contain errors: '
            + errs.join(',\n'));
        return err;
    }
    return null;
}

exports.ensureParamsValid = ensureParamsValid;
exports.formatValidationErrors = formatValidationErrors;
exports.assert = {
    updateLimitedToInternalMetadata: updateLimitedToInternalMetadata
};
exports.validateBootModules = validateBootModules;
