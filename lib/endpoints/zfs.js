/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * zfs.js: Endpoints to manage ZFS datasets and pools
 */

var mod_restify = require('restify');

var common = require('../common');

function ZFS() {}

ZFS.listDatasets = function (req, res, next) {
    var model = this.model;
    var uuid = req.params.server_uuid;

    var task = 'zfs_list_datasets';

    return (model.zfsTask(task, uuid, req.params, function (err, datasets) {
        if (err) {
            return (next(new mod_restify.InternalError(
                'cannot list datasets:' + err.message)));
        }

        res.send(datasets);
        return (next());
    }));
};

ZFS.createDataset = function (req, res, next) {
    var model = this.model;
    var uuid = req.params.server_uuid;

    var task = 'zfs_create_dataset';

    return (model.zfsTask(task, uuid, req.params, function (err) {
        if (err) {
            return (next(new mod_restify.InternalError(
                'cannot crate dataset:' + err.message)));
        }

        res.send(204);
        return (next());
    }));
};

ZFS.getProperties = function (req, res, next) {
    var model = this.model;
    var uuid = req.params.server_uuid;

    var task = 'zfs_get_properties';

    return (model.zfsTask(task, uuid, req.params, function (err, properties) {
        if (err) {
            return (next(new mod_restify.InternalError(
                'cannot get properties:' + err.message)));
        }

        res.send(properties);
        return (next());
    }));
};

ZFS.setProperties = function (req, res, next) {
    var model = this.model;
    var uuid = req.params.server_uuid;

    var task = 'zfs_set_properties';

    return (model.zfsTask(task, uuid, req.params, function (err) {
        if (err) {
            return (next(new mod_restify.InternalError(
                'cannot set properties:' + err.message)));
        }

        res.send(204);
        return (next());
    }));
};

ZFS.destroyDataset = function (req, res, next) {
    var model = this.model;
    var uuid = req.params.server_uuid;

    var task = 'zfs_destroy_dataset';

    return (model.zfsTask(task, uuid, req.params, function (err) {
        if (err) {
            return (next(new mod_restify.InternalError(
                'cannot destroy dataset:' + err.message)));
        }

        res.send(204);
        return (next());
    }));
};

ZFS.listZpools = function (req, res, next) {
    var model = this.model;
    var uuid = req.params.server_uuid;

    var task = 'zfs_list_pools';

    return (model.zfsTask(task, uuid, req.params, function (err, pools) {
        if (err) {
            return (next(new mod_restify.InternalError(
                'cannot list pools:' + err.message)));
        }

        res.send(pools);
        return (next());
    }));
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // List ZFS datasets on a server
    http.get(
        { path: '/datasets/:server_uuid', name: 'ListDatasets' },
        ZFS.listDatasets.bind(toModel));

    // Create ZFS dataset
    http.post(
        { path: '/datasets/:server_uuid', name: 'CreateDataset' },
        ZFS.createDataset.bind(toModel));

    // Get ZFS properties for a dataset
    http.get(
        { path: '/datasets/:server_uuid/props', name: 'GetProperties' },
        ZFS.getProperties.bind(toModel));

    // Set ZFS properties for a dataset
    http.post(
        { path: '/datasets/:server_uuid/props', name: 'SetProperties' },
        ZFS.setProperties.bind(toModel));

    // Destroy ZFS dataset
    http.del(
        { path: '/datasets/:server_uuid', name: 'DestroyDataset' },
        ZFS.destroyDataset.bind(toModel));


    // List ZFS pools on a server
    http.get(
        { path: '/zpools/:server_uuid', name: 'ListZpools' },
        ZFS.listZpools.bind(toModel));
}

exports.attachTo = attachTo;
