/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This file contains the logic used to reconcile the heartbeats we recieve
 * from cn-agent via the /servers/:server_uuid/events/heartbeat which are
 * written to CNAPI memory, with the cnapi_status bucket in Moray and the
 * 'status' field of servers. It sets servers' status to 'running' when it sees
 * a current heartbeat, and sets the status to 'unknown' when there has been no
 * heartbeat within HEARTBEAT_LIFETIME_SECONDS so long as no other CNAPI
 * instance has received a more recent heartbeat.
 */

var assert = require('assert-plus');
var vasync = require('vasync');
var VError = require('verror');

var buckets = require('./apis/moray').BUCKETS;
var common = require('./common');

function HeartbeatReconciler(opts) {
    var self = this;

    assert.object(opts, opts);
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.metricsManager, 'opts.metricsManager');
    assert.object(opts.moray, 'opts.moray');

    self.app = opts.app;
    self.log = opts.log;
    self.metricsManager = opts.metricsManager;
    self.moray = opts.moray;

    self.newHeartbeatersCounter = self.metricsManager.collector.counter({
        name: 'reconciler_new_heartbeaters_total',
        help: 'Counter incremented whenever a server starts heartbeating ' +
            'that has not been seen in CNAPIs recent memory'
    });
    self.newHeartbeatersCounter.add(0);

    self.staleHeartbeatersCounter = self.metricsManager.collector.counter({
        name: 'reconciler_stale_heartbeaters_total',
        help: 'Number of times servers failed to heartbeat within the ' +
            'heartbeat lifetime'
    });
    self.staleHeartbeatersCounter.add(0);

    self.usurpedHeartbeatersCounter = self.metricsManager.collector.counter({
        name: 'reconciler_usurped_heartbeaters_total',
        help: 'Number of times another CNAPI has seen more recent heartbeats ' +
            'for a server'
    });
    self.usurpedHeartbeatersCounter.add(0);

    self.serverPutsCounter = self.metricsManager.collector.counter({
        name: 'reconciler_server_put_total',
        help: 'Number of times putObject was attempted for a cnapi_servers ' +
            'record to update the status field'
    });
    self.serverPutsCounter.add(0);

    self.serverPutEtagFailuresCounter = self.metricsManager.collector.counter({
        name: 'reconciler_server_put_etag_failures_total',
        help: 'Number Etag failures while trying to put cnapi_servers objects'
    });
    self.serverPutEtagFailuresCounter.add(0);

    self.serverPutFailuresCounter = self.metricsManager.collector.counter({
        name: 'reconciler_server_failures_total',
        help: 'Total number of failures trying to put cnapi_servers objects'
    });
    self.serverPutFailuresCounter.add(0);

    self.statusPutsCounter = self.metricsManager.collector.counter({
        name: 'reconciler_status_put_total',
        help: 'Number of times putObject was attempted for a cnapi_status ' +
            'record to update the last_heartbeat'
    });
    self.statusPutsCounter.add(0);

    self.statusPutEtagFailuresCounter = self.metricsManager.collector.counter({
        name: 'reconciler_status_put_etag_failures_total',
        help: 'Number Etag failures while trying to put cnapi_status objects'
    });
    self.statusPutEtagFailuresCounter.add(0);

    self.statusPutFailuresCounter = self.metricsManager.collector.counter({
        name: 'reconciler_status_put_failures_total',
        help: 'Total number of failures trying to put cnapi_status objects'
    });
    self.statusPutFailuresCounter.add(0);
}

HeartbeatReconciler.prototype._serverUpdate =
function heartbeatServerUpdate(serverUuid, opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.nowISO, 'opts.nowISO');
    assert.string(opts.stale, 'opts.stale');

    var cnapiStatusBucket = buckets.status.name;
    var cnapiServersBucket = buckets.servers.name;
    var moray = self.moray;
    var observedStatus = self.app.observedHeartbeats[serverUuid];

    if (observedStatus.last_status_update === undefined) {
        // We either haven't seen this server before, or we lost our memory
        // of it. Either way it is new-to-us.
        self.newHeartbeatersCounter.increment();
    }

    vasync.pipeline({arg: {}, funcs: [
        function _getStatusObject(ctx, cb) {
            // Get the existing cnapi_status entry (if any) for this server.
            moray.getObject(cnapiStatusBucket, serverUuid,
                function _onGetObject(err, obj) {
                    if (!err) {
                        ctx.statusEtag = obj._etag;
                        ctx.statusObj = obj.value;
                        cb();
                        return;
                    }

                    if (VError.hasCauseWithName(err, 'ObjectNotFoundError')) {
                        cb();
                        return;
                    }

                    cb(err);
                });
        }, function _checkForTakeover(ctx, cb) {
            if (!ctx.curStatusObj) {
                // If there's no record in cnapi_status, no other CNAPI knows
                // about this server either.
                cb();
                return;
            }

            if (ctx.statusObj.last_heartbeat > observedStatus.last_heartbeat) {
                // Some CNAPI has inserted a newer heartbeat into moray.
                if (ctx.statusObj.cnapi_instance === self.app.cnapi_instance) {
                    self.log.error({
                        cnapiInstance: self.app.cnapi_instance,
                        existingHeartbeat: ctx.statusObj.last_heartbeat,
                        newHeartbeat: observedStatus.last_heartbeat,
                        serverUuid: serverUuid
                    }, 'Malfunction: cnapi_status heartbeat from the future');
                } else {
                    self.log.debug({
                        serverUuid: serverUuid,
                        usurper: ctx.statusObj.cnapi_instance
                    }, 'Another CNAPI took over for server we lost.');
                    // Delete from our memory, if it comes back we treat as new.
                    delete self.app.observedHeartbeats[serverUuid];
                    self.usurpedHeartbeatersCounter.increment();
                }
                // In any case, we'll not overwrite a newer last_heartbeat.
                ctx.skip = true;
                cb();
                return;
            }

            /*
             * Here we know:
             *
             *  - there's an existing record for this server in cnapi_status
             *  - the existing record has an older last_heartbeat than we've
             *    seen
             *
             * so we'll plow forward and update, since we have newer intel.
             *
             */
             cb();
        }, function _putStatusObject(ctx, cb) {
            ctx.didPut = false;

            if (ctx.skip) {
                cb();
                return;
            }

            self.statusPutsCounter.increment();

            moray.putObject(cnapiStatusBucket, serverUuid, {
                cnapi_instance: self.app.cnapi_instance,
                last_heartbeat: observedStatus.last_heartbeat,
                server_uuid: serverUuid
            }, { etag: ctx.statusEtag }, function _onPutObject(err) {
                if (err) {
                    self.statusPutFailuresCounter.increment();

                    if (VError.hasCauseWithName(err, 'EtagConflictError')) {
                        // If the put fails due to Etag conflict (or any other
                        // error), we'll record it but not do anything else.
                        // Since the state won't have changed unless we got a
                        // fresh heartbeat, we'll just try again next time the
                        // reconciler is run.
                        self.statusPutEtagFailuresCounter.increment();
                    }
                } else {
                    // Update our observed state to indicate we've written now.
                    observedStatus.last_status_update = opts.nowISO;
                    ctx.didPut = true;
                }

                cb(err);
            });
        }, function _evaluateNeedForUpdatingServerStatus(ctx, cb) {
            if (ctx.skip || !ctx.didPut) {
                cb();
                return;
            }

            // If we got here, we updated the record in cnapi_servers, so we
            // want to make sure the 'status' is correct in the server object.
            if (observedStatus.last_heartbeat !== undefined &&
                observedStatus.last_heartbeat < opts.stale) {

                // Lifetime of last heartbeat expired, we don't know status but
                // no other CNAPI could know either (since we'd not get here
                // unless we just put the cnapi_status record).
                ctx.newServerStatus = 'unknown';
                self.staleHeartbeatersCounter.increment();
            } else {
                ctx.newServerStatus = 'running';
            }

            self.log.trace({
                newStatus: ctx.newServerStatus,
                serverUuid: serverUuid
            }, 'Will update "status" for server');

            if (ctx.newServerStatus === 'unknown') {
                // We're not in control of this server any more. Delete from our
                // memory and treat as new if it shows up again.
                delete self.app.observedHeartbeats[serverUuid];
            }

            cb();
        }, function _getExistingServerObj(ctx, cb) {
            if (ctx.newServerStatus === undefined) {
                // We're only here to get the server object so we can update it,
                // if we're not updating it, no need to grab current object.
                cb();
                return;
            }

            moray.getObject(cnapiServersBucket, serverUuid,
                function _gotServerObject(err, serverObj) {
                    if (err) {
                        // If there was any error getting the server (including
                        // NotFound) we won't be able to do a put even though we
                        // might already have updated the last_heartbeat in
                        // cnapi_status. So what we do is remove our in-memory
                        // record of this server so that next time it heartbeats
                        // and the reconciler runs, we'll treat it as a new
                        // server and try again.
                        delete self.app.observedHeartbeats[serverUuid];
                        cb(err);
                        return;
                    }

                    if (serverObj.value.status === ctx.newServerStatus) {
                        self.log.debug({
                            newStatus: ctx.newServerStatus,
                            serverUuid: serverUuid
                        }, 'Server already has target status no update needed');
                    } else {
                        ctx.serverEtag = serverObj._etag;
                        ctx.serverObj = serverObj.value;
                    }

                    cb();
                });
        }, function _putServerObj(ctx, cb) {
            var newServerObj;

            if (ctx.serverObj === undefined) {
                // We're only here to put the updated server object. If we
                // didn't load a server record, there's nothing to update.
                cb();
                return;
            }

            assert.string(ctx.newServerStatus, 'ctx.newServerStatus');

            newServerObj = ctx.serverObj;
            newServerObj.status = ctx.newServerStatus;

            self.serverPutsCounter.increment();

            moray.putObject(cnapiServersBucket, serverUuid, newServerObj,
                {etag: ctx.serverEtag}, function _onPutServer(err) {

                if (err) {
                    self.serverPutFailuresCounter.increment();
                    self.log.error({
                        err: err,
                        serverUuid: serverUuid
                    }, 'Error updating server in moray');

                    if (VError.hasCauseWithName(err, 'EtagConflictError')) {
                        self.serverPutEtagFailuresCounter.increment();
                    }

                    // On *any* error putting the new server record, we'll
                    // remove the in-memory state for this server. This way on
                    // the next reconciliation after the next heartbeat, we'll
                    // treat it as a new server and try to update it again.
                    delete self.app.observedHeartbeats[serverUuid];
                }

                cb(err);
            });
        }
    ]}, function _updatePipelineComplete(err) {
        callback(err);
    });
};

/*
 * In the server_status bucket we have objects that look like:
 *
 *   {
 *       "server_uuid": <uuid>,
 *       "last_heartbeat": <timestamp>,
 *       "cnapi_instance": <uuid>
 *   }
 *
 * In each CNAPI instance we also maintain the ModelServer.heartbeatByServerUuid
 *
 */
HeartbeatReconciler.prototype.reconcile =
function heartbeatReconcile(callback) {
    var self = this;

    var expirationMs = (common.HEARTBEAT_LIFETIME_SECONDS * 1000);
    var now = Date.now();
    var nowISO = new Date(now).toISOString();
    var stale = new Date(now - expirationMs).toISOString();
    var toUpdate = [];
    var uuids = Object.keys(self.app.observedHeartbeats);

    self.log.trace({
        nowISO: nowISO,
        numUuids: uuids.length,
        stale: stale
    }, 'Running heartbeat reconciler.');

    function _selectServersToUpdate(serverUuid) {
        var server = self.app.observedHeartbeats[serverUuid];

        if (server.last_status_update === undefined) {
            // If there's no last_status_update it's new to us and we need
            // to update since we don't know the history.
            self.log.trace({server: server},
                'No last_status_update for server, selecting for update.');
            return true;
        }

        if (server.last_heartbeat !== undefined &&
            server.last_heartbeat < stale) {

            // If the last_heartbeat is stale, we need to update status to
            // 'unknown' unless some other CNAPI is now seeing it.
            self.log.trace({server: server}, 'last_heartbeat is stale, need ' +
                'to update with the last one we actually saw.');
            return true;
        }

        // No need to update the status otherwise.
        self.log.trace({server: server}, 'No need to update heartbeat status');
        return false;
    }

    toUpdate = uuids.filter(_selectServersToUpdate);

    /*
     * We do this serially to try to cause minimum disruption to other things
     * going on.
     */
    vasync.forEachPipeline({
        func: function _updateServer(serverUuid, cb) {
            self._serverUpdate(serverUuid, {
                nowISO: nowISO,
                stale: stale
            }, cb);
        },
        inputs: toUpdate
    }, function _pipelineComplete(err) {
        callback(err);
    });
};

module.exports = HeartbeatReconciler;
