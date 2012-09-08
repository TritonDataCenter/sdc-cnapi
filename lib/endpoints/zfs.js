/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * zfs.js: Endpoints to manage ZFS datasets and pools
 */

var common = require('../common');
var restify = require('restify');
var util = require('util');
var ModelServer = require('../models/server');

function ZFS() {}

ZFS.listDatasets = function (req, res, next) {
    var server = req.params.server;

    server.zfsTask('zfs_list_datasets', req.params, function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot list datasets:' + err.message)));
        }

        res.send(results);
        return (next());
    });
};

ZFS.createDataset = function (req, res, next) {
    var server = req.params.server;

    server.zfsTask('zfs_create_dataset', req.params, function (err) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot create dataset:' + err.message)));
        }

        res.send(204);
        return (next());
    });
};

var findProps = function (params) {
    var properties = [];

    for (var key in params) {
        if (params.hasOwnProperty(key) &&
            key.substr(0, 4) === 'prop') {
            properties.push(params[key]);
        }
    }

    return (properties);
};

ZFS.getAllProperties = function (req, res, next) {
    var server = req.params.server;

    var options = {};
    var properties = findProps(req.params);
    if (properties.length > 0)
        options.properties = properties;

    server.zfsTask('zfs_get_properties', options, function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot get properties:' + err.message)));
        }

        // XXX I need to talk to Orlando about this
        delete results.log;

        res.send(results);
        return (next());
    });
};

ZFS.getProperties = function (req, res, next) {
    var server = req.params.server;
    var dataset = req.params.dataset;

    var options = {};
    options.dataset = dataset;
    var properties = findProps(req.params);
    if (properties.length > 0)
        options.properties = properties;

    // XXX Handle case where pool is specified or not

    server.zfsTask('zfs_get_properties', options, function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot get properties:' + err.message)));
        }

        // XXX I need to talk to Orlando about this
        delete results.log;

        res.send(results);
        return (next());
    });
};

ZFS.setProperties = function (req, res, next) {
    var server = req.params.server;

    server.zfsTask('zfs_set_properties', req.params, function (err) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot set properties:' + err.message)));
        }

        res.send(204);
        return (next());
    });
};

ZFS.destroyDataset = function (req, res, next) {
    var server = req.params.server;

    server.zfsTask('zfs_destroy_dataset', req.params, function (err) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot destroy dataset:' + err.message)));
        }

        res.send(204);
        return (next());
    });
};

ZFS.listZpools = function (req, res, next) {
    var server = req.params.server;

    server.zfsTask('zfs_list_pools', req.params, function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot list pools:' + err.message)));
        }

        res.send(results);
        return (next());
    });
};

function attachTo(http) {
    var before = [
        function (req, res, next) {
            if (!req.params.server_uuid) {
                next();
                return;
            }

            req.params.server = new ModelServer(req.params.server_uuid);
            req.params.server.get(function (error, server) {
                // Check if any servers were returned
                if (!server) {
                    var errorMsg
                        = 'Server ' + req.params.server_uuid + ' not found';
                    next(
                        new restify.ResourceNotFoundError(errorMsg));
                    return;
                }
                req.params.serverAttributes = server;
                next();
            });
        }
    ];

    // List ZFS datasets on a server
    http.get(
        { path: '/servers/:server_uuid/datasets', name: 'ListDatasets' },
        before, ZFS.listDatasets);

    // Create ZFS dataset
    http.post(
        { path: '/servers/:server_uuid/datasets', name: 'CreateDataset' },
        before, ZFS.createDataset);

    // Get ZFS properties for all dataset
    http.get(
        { path: '/servers/:server_uuid/dataset-properties',
          name: 'GetAllProperties' },
        before, ZFS.getAllProperties);

    // Get ZFS properties for a dataset
    http.get(
        { path: '/servers/:server_uuid/datasets/:dataset/properties',
          name: 'GetProperties' },
        before, ZFS.getProperties);

    // Set ZFS properties for a dataset
    http.post(
        { path: '/servers/:server_uuid/datasets/:dataset/properties',
          name: 'SetProperties' },
        before, ZFS.setProperties);

    // Destroy ZFS dataset
    http.del(
        { path: '/servers/:server_uuid/datasets/:dataset',
          name: 'DestroyDataset' },
        before, ZFS.destroyDataset);


    // List ZFS pools on a server
    http.get(
        { path: '/servers/:server_uuid/zpools', name: 'ListZpools' },
        before, ZFS.listZpools);
}

exports.attachTo = attachTo;
