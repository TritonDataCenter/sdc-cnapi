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


/**
 * List ZFS datasets on a server.
 *
 * @name DatasetsList
 * @endpoint GET GET /servers/:server_uuid/datasets
 * @section ZFS
 *
 * @example GET /servers/44454c4c-4800-1034-804a-b2c04f354d31/datasets
 *
 * @response 200 Array Array of objects, one per dataset on server
 */

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


/**
 * Create a ZFS dataset on a server.
 *
 * @name DatasetCreate
 * @endpoint POST /servers/:server_uuid/datasets
 * @section ZFS
 *
 * @example POST /servers/44454c4c-4800-1034-804a-b2c04f354d31/datasets
 *         -d "datasets=zones/myfs"
 *
 * @response 204 None Dataset successfully created
 */

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


/**
 * Create a ZFS snapshot of a dataset on a server.
 *
 * @name SnapshotCreate
 * @endpoint POST /servers/:server_uuid/datasets/:dataset/snapshot
 * @section ZFS
 *
 * @param {String} name The name of the snapshot to create
 *
 * @example POST /servers/44454c4c-4800-1034-804a-b2c04f354d31\
 *          /datasets/zones%2Fmyfs/snapshot -d '{ "name": "backup" }'
 *
 * @response 204 None Snapshot successfully created
 */

ZFS.createSnapshot = function (req, res, next) {
    var server = req.params.server;

    var name = req.params.name;
    var snapshot = req.params.dataset + '@' + name;

    server.zfsTask(
        'zfs_snapshot_dataset',
        { dataset: snapshot },
        function (err) {
            if (err) {
                next(new restify.InternalError(
                    'cannot create snapshot: ' + err.message));
                return;
            }
            res.send(204);
            next();
            return;
        });
};

/**
 * Revert a ZFS dataset to back to a previous state captured by a snapshot.
 *
 * @name SnapshotRollback
 * @endpoint POST /servers/:server_uuid/datasets/:dataset/rollback
 * @section ZFS
 *
 * @param {String} name The name of the snapshot to be created
 *
 * @example POST /servers/44454c4c-4800-1034-804a-b2c04f354d31
 *          /datasets/zones%2Fmyfs/rollback -d '{ "name": "backup" }'
 *
 * @response 204 None Snapshot successfully rolled back
 */

ZFS.rollbackSnapshot = function (req, res, next) {
    var server = req.params.server;

    var name = req.params.name;
    var snapshot = req.params.dataset + '@' + name;

    server.zfsTask(
        'zfs_rollback_dataset',
        { dataset: snapshot },
        function (err) {
            if (err) {
                next(new restify.InternalError(
                    'cannot create snapshot: ' + err.message));
                return;
            }
            res.send(204);
            next();
            return;
        });
};


/**
 * List all snapshots on a dataset
 *
 * @name SnapshotList
 * @endpoint GET /servers/:server_uuid/datasets/:dataset/snapshots
 * @section ZFS
 *
 * @example GET /servers/44454c4c-4800-1034-804a-b2c04f354d31/datasets
 *
 * @response 200 Array Array of snapshot objects
 */

ZFS.listSnapshots = function (req, res, next) {
    var server = req.params.server;

    server.zfsTask('zfs_list_snapshots', req.params, function (err, results) {
        if (err) {
            return (next(new restify.InternalError(
                'cannot list snapshots:' + err.message)));
        }

        res.send(results);
        return (next());
    });
};


function findProps(params) {
    var properties = [];

    for (var key in params) {
        if (params.hasOwnProperty(key) &&
            key.substr(0, 4) === 'prop') {
            properties.push(params[key]);
        }
    }

    return (properties);
}


/**
 * Get ZFS properties across all datasets on a server.
 *
 * @name DatasetPropertiesGetAll
 * @endpoint GET /servers/:server_uuid/dataset-properties
 * @section ZFS
 *
 * @param {String} <prop1> Get the property given by the "prop1" value
 * @param {String} <prop2> Get the property given by the "prop2" value
 * @param {String} <propN> Get the property given by the "propN" value
 *
 * @example GET /servers/44454c4c-4800-1034-804a-b2c04f354d31\
 *          /dataset-properties?prop1=mountpoint
 * @response 200 Object list of property details
 */

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


/**
 * Get ZFS properties for a dataset.  The specific properties to return can be
 * filtered with ?prop1=foo&prop2=bar, etc.
 *
 * @name DatasetPropertiesGet
 * @endpoint GET /servers/:server_uuid/datasets/:dataset/properties
 * @section ZFS
 *
 * @param {String} <prop1> Get the property given by the "prop1" value
 * @param {String} <prop2> Get the property given by the "prop2" value
 * @param {String} <propN> Get the property given by the "propN" value
 *
 * @example GET /servers/44454c4c-4800-1034-804a-b2c04f354d31
 *          /datasets/zones%2fmyfs/properties
 * @example GET /servers/44454c4c-4800-1034-804a-b2c04f354d31
 *          /datasets/zones%2fmyfs/properties
 *           -d '{ "prop1": "quota", "prop2": "available" }'
 *
 * @response 200 Array List of dataset property details
 */

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


/**
 * Set one or more properties for a ZFS dataset.
 *
 * @name DatasetPropertiesSet
 * @endpoint POST /servers/:server_uuid/datasets/:dataset/properties
 * @section ZFS
 *
 * @param {Object} properties Object containing string property values
 *
 * @example POST /servers/44454c4c-4800-1034-804a-b2c04f354d31
 *          /datasets/zones\/myfs/properties -d \
 *         '{
 *              "properties": {
 *                  "quota": "5G"
 *              }
 *         }'
 *
 * @response 204 None Properties were set successfully
 */

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


/**
 * Destroy a ZFS dataset on a server.
 *
 * @name DatasetDestroy
 * @endpoint DELETE /servers/:server_uuid/datasets/:dataset
 * @section ZFS
 *
 * @example DELETE /servers/44454c4c-4800-1034-804a-b2c04f354d31
 *          /datasets/zones%2fmyfs
 *
 * @response 204 None Dataset successfully deleted
 */

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


/**
 * List the ZFS pools on a server.
 *
 * @name ZpoolList
 * @endpoint GET /servers/:server_uuid/zpools
 * @section ZFS
 *
 * @example GET /servers/44454c4c-4800-1034-804a-b2c04f354d31/zpools
 *
 * @response 200 Array List of zpool detail objects
 */

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
            req.params.server.getRaw(function (error, server) {
                // Check if any servers were returned
                if (!server) {
                    var errorMsg
                        = 'Server ' + req.params.server_uuid + ' not found';
                    next(
                        new restify.ResourceNotFoundError(errorMsg));
                    return;
                }
                next();
            });
        }
    ];

    // List ZFS datasets on a server
    http.get(
        { path: '/servers/:server_uuid/datasets', name: 'DatasetList' },
        before, ZFS.listDatasets);

    // Create ZFS dataset
    http.post(
        { path: '/servers/:server_uuid/datasets', name: 'DatasetCreate' },
        before, ZFS.createDataset);

    // Create a snapshot
    http.post(
        { path: '/servers/:server_uuid/datasets/:dataset/snapshot',
          name: 'SnapshotCreate' },
        before, ZFS.createSnapshot);

    // Rollback a snapshot
    http.post(
        { path: '/servers/:server_uuid/datasets/:dataset/rollback',
          name: 'SnapshotRollback' },
        before, ZFS.rollbackSnapshot);

    // List snapshots
    http.get(
        { path: '/servers/:server_uuid/datasets/:dataset/snapshots',
          name: 'SnapshotList' },
        before, ZFS.listSnapshots);

    // Get ZFS properties for all dataset
    http.get(
        { path: '/servers/:server_uuid/dataset-properties',
          name: 'DatasetPropertiesGetAll' },
        before, ZFS.getAllProperties);

    // Get ZFS properties for a dataset
    http.get(
        { path: '/servers/:server_uuid/datasets/:dataset/properties',
          name: 'DatasePropertiesGet' },
        before, ZFS.getProperties);

    // Set ZFS properties for a dataset
    http.post(
        { path: '/servers/:server_uuid/datasets/:dataset/properties',
          name: 'DatasetPropertiesSet' },
        before, ZFS.setProperties);

    // Destroy ZFS dataset
    http.del(
        { path: '/servers/:server_uuid/datasets/:dataset',
          name: 'DatasetDestroy' },
        before, ZFS.destroyDataset);


    // List ZFS pools on a server
    http.get(
        { path: '/servers/:server_uuid/zpools', name: 'ZpoolList' },
        before, ZFS.listZpools);
}

exports.attachTo = attachTo;
