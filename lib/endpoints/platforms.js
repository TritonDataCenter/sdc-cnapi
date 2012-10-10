var async = require('async');
var restify = require('restify');
var fs = require('fs');
var util = require('util');
var ModelPlatform = require('../models/platform');

function Platform() {}

Platform.init = function () {
    Platform.log = ModelPlatform.log;
};

Platform.list = function (req, res, next) {
    ModelPlatform.list({}, function (error, platforms) {
        if (error) {
            next(
                new restify.InternalError(error.message));
            return;
        }
        res.send(200, platforms);
        next();
    });
};

function attachTo(http, model) {
    Platform.init();

    // List servers
    http.get(
        { path: '/platforms', name: 'PlatformList' },
        Platform.list);
}

exports.attachTo = attachTo;
