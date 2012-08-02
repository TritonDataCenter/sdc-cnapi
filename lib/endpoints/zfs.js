/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * zfs.js: Endpoints to manage ZFS datasets and pools
 */

var common = require('../common');
var restify = require('restify');
var util = require('util');

function ZFS() {}

ZFS.listDatasets = function (req, res, next) {
    var model = this.model;
    var server = req.params.server;

    return (model.zfsTask('zfs_list_datasets', server, req.params,
    function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot list datasets:' + err.message)));
        }

        res.send(results);
        return (next());
    }));
};

ZFS.createDataset = function (req, res, next) {
    var model = this.model;
    var server = req.params.server;

    return (model.zfsTask('zfs_create_dataset', server, req.params,
    function (err) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot create dataset:' + err.message)));
        }

        res.send(204);
        return (next());
    }));
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
    var model = this.model;
    var server = req.params.server;

    var options = {};
    var properties = findProps(req.params);
    if (properties.length > 0)
        options.properties = properties;

    return (model.zfsTask('zfs_get_properties', server, options,
    function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot get properties:' + err.message)));
        }

        // XXX I need to talk to Orlando about this
        delete results.log;

        res.send(results);
        return (next());
    }));
};

ZFS.getProperties = function (req, res, next) {
    var model = this.model;
    var server = req.params.server;
    var dataset = req.params.dataset;

    var options = {};
    options.dataset = dataset;
    var properties = findProps(req.params);
    if (properties.length > 0)
        options.properties = properties;

    // XXX Handle case where pool is specified or not

    return (model.zfsTask('zfs_get_properties', server, options,
    function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot get properties:' + err.message)));
        }

        // XXX I need to talk to Orlando about this
        delete results.log;

        res.send(results);
        return (next());
    }));
};

ZFS.setProperties = function (req, res, next) {
    var model = this.model;
    var server = req.params.server;

    return (model.zfsTask('zfs_set_properties', server, req.params,
    function (err) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot set properties:' + err.message)));
        }

        res.send(204);
        return (next());
    }));
};

ZFS.destroyDataset = function (req, res, next) {
    var model = this.model;
    var server = req.params.server;

    return (model.zfsTask('zfs_destroy_dataset', server, req.params,
    function (err) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot destroy dataset:' + err.message)));
        }

        res.send(204);
        return (next());
    }));
};

ZFS.listZpools = function (req, res, next) {
    var model = this.model;
    var server = req.params.server;

    return (model.zfsTask('zfs_list_pools', server, req.params,
    function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot list pools:' + err.message)));
        }

        res.send(results);
        return (next());
    }));
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // List ZFS datasets on a server
    http.get(
        { path: '/datasets/:server', name: 'ListDatasets' },
        ZFS.listDatasets.bind(toModel));

    // Create ZFS dataset
    http.post(
        { path: '/datasets/:server', name: 'CreateDataset' },
        ZFS.createDataset.bind(toModel));

    // Get ZFS properties for all dataset
    http.get(
        { path: '/datasets/:server/properties', name: 'GetAllProperties' },
        ZFS.getAllProperties.bind(toModel));

    // Get ZFS properties for a dataset
    http.get(
        { path: '/datasets/:server/properties/:dataset',
          name: 'GetProperties' },
        ZFS.getProperties.bind(toModel));

    // Set ZFS properties for a dataset
    http.post(
        { path: '/datasets/:server/properties/:dataset',
          name: 'SetProperties' },
        ZFS.setProperties.bind(toModel));

    // Destroy ZFS dataset
    http.del(
        { path: '/datasets/:server', name: 'DestroyDataset' },
        ZFS.destroyDataset.bind(toModel));


    // List ZFS pools on a server
    http.get(
        { path: '/zpools/:server', name: 'ListZpools' },
        ZFS.listZpools.bind(toModel));
}

exports.attachTo = attachTo;
