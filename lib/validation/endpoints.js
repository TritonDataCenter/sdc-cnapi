/*!
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints validation routines.
 *
 */

var sprintf = require('sprintf').sprintf;
var VError = require('verror');
var restify = require('restify');
var restify_validator = require('restify-validator');

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
    var rule;
    var skip = false;

    opts = opts || {};

    if (opts.strict) {
        for (var param in req.params) {
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

            if (global.toString.call(rule) == '[object String]') {
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

                    if (!req.params.hasOwnProperty(paramName)) {
                        skip = true;
                        req.params[paramName] = rule[1];
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
        if (keys.length != 1 || keys[0] !== 'set_internal_metadata') {
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

exports.ensureParamsValid = ensureParamsValid;
exports.formatValidationErrors = formatValidationErrors;
exports.assert = {
    updateLimitedToInternalMetadata: updateLimitedToInternalMetadata
};
