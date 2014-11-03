/*!
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints validation routines.
 *
 */

var sprintf = require('sprintf').sprintf;
var verror = require('verror');
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

function ensureParamsValid(req, res, paramRules) {
    var rule;
    var skip = false;

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
                        throw new verror.VError(
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
                throw new verror.VError('Unknown rule: %s', ruleName);
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

exports.ensureParamsValid = ensureParamsValid;
exports.formatValidationErrors = formatValidationErrors;
