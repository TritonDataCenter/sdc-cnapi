/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var restify = require('restify');
var util = require('util');



// ---- globals

var p = console.warn;
var fmt = util.format;
var RestError = restify.RestError;



// ---- exported functions

/**
 * Extend the default Restify 'text/plain' formatter to include the
 * `err.restCode` string in returned error messages.
 */
function formatErrOrText(req, res, body) {
    if (body instanceof Error) {
        res.statusCode = body.statusCode || 500;
        if (body.restCode && body.restCode !== 'CnapiError') {
            body = fmt('(%s) %s', body.restCode, body.message);
        } else {
            body = body.message;
        }
        body += ' (' + req.getId() + ')';

        // Update `res._body` for the audit logger.
        res._body = body;
    } else if (typeof (body) === 'object') {
        body = JSON.stringify(body);
    } else {
        body = body.toString();
    }

    res.setHeader('Content-Length', Buffer.byteLength(body));
    return (body);
}


// ---- CNAPI-specific error class hierarchy

/**
 * Base class for all of our CNAPI errors. This shouldn't be exported,
 * because all usages should be of one of the subclasses.
 *
 * This is a light wrapper around RestError to add some common `cause.body`
 * attributes for logging.
 */
function _CnapiBaseError(opts) {
    assert.object(opts, 'opts');
    RestError.call(this, opts);
    if (opts.cause && opts.cause.body) {
        this.body.errors = opts.cause.body.errors;
    }
}
util.inherits(_CnapiBaseError, RestError);


/**
 * The generic catch-all error to throw if there isn't a specific error class.
 *
 * Usage:
 *      new CnapiError(message);
 *      new CnapiError(cause, message);
 */
function CnapiError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message, 'message');
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: (cause && cause.statusCode) || this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(CnapiError, _CnapiBaseError);
CnapiError.prototype.name = 'CnapiError';
CnapiError.restCode = 'CnapiError';
CnapiError.statusCode = 500;
CnapiError.description =
    'Encountered an internal error while fulfilling request.';


/**
 * TODO(trentm): call this just "TimeoutError"?
 */
function CommandTimeoutError(cause) {
    assert.object(cause, 'cause');
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: 'timed-out waiting for request response',
        cause: cause
    });
}
util.inherits(CommandTimeoutError, _CnapiBaseError);
CommandTimeoutError.prototype.name = 'CommandTimeoutError';
CommandTimeoutError.restCode = 'CommandTimeout';
CommandTimeoutError.statusCode = 500;
CommandTimeoutError.description = 'Timed-out waiting for request response.';




function NotImplementedError(feature) {
_CnapiBaseError.call(this, {
    restCode: this.constructor.restCode,
    statusCode: this.constructor.statusCode,
    message: feature + ' is not implemented'
});
}
util.inherits(NotImplementedError, _CnapiBaseError);
NotImplementedError.prototype.name = 'NotImplementedError';
NotImplementedError.restCode = 'NotImplemented';
NotImplementedError.statusCode = 400;
NotImplementedError.description =
'Attempt to use a feature that is not yet implemented';



function NoAllocatableServersError() {
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
            message: 'No compute resources available'
        });
}
util.inherits(NoAllocatableServersError, _CnapiBaseError);
NoAllocatableServersError.prototype.name = 'NoAllocatableServersError';
NoAllocatableServersError.restCode = 'NoAllocatableServersError';
NoAllocatableServersError.statusCode = 409;
NoAllocatableServersError.description = 'No compute resources available';



function VolumeServerNoResourcesError() {
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message:
            'No compute resources available on ' +
            'the host containing the mounted volume'
    });
}
util.inherits(VolumeServerNoResourcesError, _CnapiBaseError);
VolumeServerNoResourcesError.prototype.name = 'VolumeServerNoResourcesError';
VolumeServerNoResourcesError.restCode = 'VolumeServerNoResourcesError';
VolumeServerNoResourcesError.statusCode = 409;
VolumeServerNoResourcesError.description =
    'No compute resources available on the host containing the mounted volume';



function VmNotRunningError() {
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message:
            'Operation attempted on vm which is not running' });
}
util.inherits(VmNotRunningError, _CnapiBaseError);
VmNotRunningError.prototype.name = 'VmNotRunningError';
VmNotRunningError.restCode = 'VmNotRunning';
VmNotRunningError.statusCode = 409;
VmNotRunningError.description =
    'Operation attempted on vm which is not running';


function ServerNotRunningError() {
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message:
            'Operation attempted on server which is not running' });
}
util.inherits(ServerNotRunningError, _CnapiBaseError);
ServerNotRunningError.prototype.name = 'ServerNotRunningError';
ServerNotRunningError.restCode = 'ServerNotRunning';
ServerNotRunningError.statusCode = 409;
ServerNotRunningError.description =
    'Operation attempted on server which is not running';

function FileNotFoundError() {
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message:
            'Could not find requested file' });
}
util.inherits(FileNotFoundError, _CnapiBaseError);
FileNotFoundError.prototype.name = 'FileNotFoundError';
FileNotFoundError.restCode = 'FileNotFound';
FileNotFoundError.statusCode = 404;
FileNotFoundError.description = 'could not find requested file';

var unsupportedDockerCopyStoppedMessage
    = 'This container must be running in order to use `docker cp`';
function DockerCopyStoppedContainerNoPlatformSupportError() {
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: unsupportedDockerCopyStoppedMessage
    });
}

util.inherits(
    DockerCopyStoppedContainerNoPlatformSupportError, _CnapiBaseError);
DockerCopyStoppedContainerNoPlatformSupportError.prototype.name =
    'DockerCopyStoppedContainerNoPlatformSupportError';
DockerCopyStoppedContainerNoPlatformSupportError.restCode =
    'DockerCopyStoppedContainerNoPlatformSupport';
DockerCopyStoppedContainerNoPlatformSupportError.statusCode = 409;
DockerCopyStoppedContainerNoPlatformSupportError.description =
    unsupportedDockerCopyStoppedMessage;


function PathNotDirectoryError() {
    _CnapiBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message:
            'Given path was not to a directory' });
}
util.inherits(PathNotDirectoryError, _CnapiBaseError);
PathNotDirectoryError.prototype.name = 'PathNotDirectoryError';
PathNotDirectoryError.restCode = 'PathNotDirectory';
PathNotDirectoryError.statusCode = 400;
PathNotDirectoryError.description = 'given path was not to a directory';

// ---- exports

module.exports = {
    formatErrOrText: formatErrOrText,

    InternalError: restify.InternalError,
    ResourceNotFoundError: restify.ResourceNotFoundError,
    InvalidHeaderError: restify.InvalidHeaderError,
    ServiceUnavailableError: restify.ServiceUnavailableError,
    ForbiddenError: restify.ForbiddenError,
    BadRequestError: restify.BadRequestError,

    CnapiError: CnapiError,
    NoAllocatableServersError: NoAllocatableServersError,
    VolumeServerNoResourcesError: VolumeServerNoResourcesError,
    CommandTimeoutError: CommandTimeoutError,
    NotImplementedError: NotImplementedError,
    VmNotRunningError: VmNotRunningError,
    ServerNotRunningError: ServerNotRunningError,
    FileNotFoundError: FileNotFoundError,
    PathNotDirectoryError: PathNotDirectoryError,
    DockerCopyStoppedContainerNoPlatformSupportError:
        DockerCopyStoppedContainerNoPlatformSupportError
};
