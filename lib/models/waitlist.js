/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * The waitlist subsystem is responsible for serializing access to datacenter
 * resources.
 *
 * See the "Waitlist" section in docs/index.md for more information.
 */

var assert = require('assert-plus');
var async = require('async');
var backoff = require('backoff');
var libuuid = require('libuuid');
var once = require('once');
var sprintf = require('sprintf').sprintf;
var vasync = require('vasync');
var VError = require('verror');
var jsprim = require('jsprim');
var restify = require('restify');

var ModelBase = require('./base');
var buckets = require('../apis/moray').BUCKETS;
var common = require('../common');

// Ticket status values
var TICKET_STATUS_ACTIVE = 'active';
var TICKET_STATUS_EXPIRED = 'expired';
var TICKET_STATUS_FINISHED = 'finished';
var TICKET_STATUS_QUEUED = 'queued';

// Ticket modify operations
var TICKET_OPERATION_DELETE = 'delete';
var TICKET_OPERATION_CREATE = 'create';
var TICKET_OPERATION_UPDATE = 'update';

// Moray bucket
var MORAY_BUCKET_WAITLIST_TICKETS = buckets.waitlist_tickets.name;

// How long, (in ms), between checks to moray for ticket updates
var WAITLIST_PERIOD_MS = 500;

// Period (ms) between attempts to ensure activation of tickets.
var WAITLIST_PERIODIC_ACTIVATION_PERIOD_MS = 60 * 1000;

// How long, (in ms), between attempts to clean old tickets out of moray
var WAITLIST_CLEANUP_PERIOD_MS = 3600 * 1000;

// When cleanup occurs, delete tickets that are past this threshold (1mo)
var WAITLIST_CLEANUP_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/*
 * The WaitlistDirector periodically checks moray for waitlist tickets that
 * have been updated and takes appropriate action, such as: dispatching wait
 * callbacks and updating ticket statuses.
 *
 * There will only be one instance of this object per running CNAPI instance.
 */

function WaitlistDirector(params) {
    var self = this;
    self.params = params;
    self.log = ModelWaitlist.log;
    self.callbacks = {};
}


/*
 * Begin checking moray for ticket updates and taking action based on those
 * changes.
 */

WaitlistDirector.prototype.start =
function WaitlistDirectorStart() {
    var self = this;

    var lastCheck;
    var start = new Date();

    self.log.info('starting WaitlistDirector');

    if (!WaitlistDirector.timeout) {
        clearInterval(WaitlistDirector.timeout);
    }

    // Start the timer responsible for checking for ticket updates.
    WaitlistDirector.timeout = setTimeout(intervalFn, WAITLIST_PERIOD_MS);

    // Start the timer responsible for cleaning up old tickets.
    WaitlistDirector.cleanupTimeout =
        setTimeout(cleanupIntervalFn, WAITLIST_CLEANUP_PERIOD_MS);

    // Ensure we don't stop activating tickets.
    activationTimerFn();

    function activationTimerFn() {
        WaitlistDirector.activationTimer = setTimeout(function () {
            self.ensureServerQueuesHaveActiveTickets(
            function (activateError) {
                activationTimerFn();

                if (activateError) {
                    self.log.error({ error: activateError },
                        'error ensuring server queues have active tickets');
                }
            });
        }, WAITLIST_PERIODIC_ACTIVATION_PERIOD_MS);

    }

    function intervalFn() {
        var params = { timestamp: lastCheck && new Date(lastCheck - 1000) };
        start = new Date();
        ModelWaitlist.ticketsUpdatedSince(params, onTicketsUpdated);
    }

    function cleanupIntervalFn() {
        WaitlistDirector.cleanupOldTickets(self.log, onTicketsCleanedUp);
    }

    // This gets called every time we check and find tickets that have been
    // updated since the last time we looked.
    function onTicketsUpdated(error, tickets) {
        // We want this rescheduled even if we get an error
        WaitlistDirector.timeout = setTimeout(intervalFn, WAITLIST_PERIOD_MS);

        if (error) {
            self.log.error({ error: error }, 'failed to get tickets since %s',
                lastCheck);
        }

        var date = lastCheck;
        lastCheck = new Date();

        // If there are tickets with an updated_at time later than the last
        // time we last checked, process those tickets.
        if (tickets && tickets.length) {
            self.log.info({ tickets: tickets },
                           'tickets updated since %s (started at %s)',
                           date ? date.toISOString() : 'start-up',
                           start.toISOString());

            self.onUpdate(date, tickets);
        } else {
            self.log.trace('no tickets updated since %s',
                       date ? date.toISOString() : 'start-up',
                       start.toISOString());
        }
    }

    function onTicketsCleanedUp(error) {
        if (error) {
            self.log.error({ error: error }, 'error cleaning up tickets');
        }

        WaitlistDirector.cleanupTimeout =
            setTimeout(cleanupIntervalFn, WAITLIST_CLEANUP_PERIOD_MS);
    }
};


/*
 * Called with a timestamp and list of tickets that have had their
 * `updated_at` value updated since last we checked. This will dispatch
 * callbacks for "wait" on ticket status going to "expire" or "finished", and
 * make sure that any tickets in which now() > `expires_at` get marked as
 * 'expired'.
 */

WaitlistDirector.prototype.onUpdate =
function WaitlistDirectorOnUpdate(timestamp, tickets) {
    var self = this;

    assert.optionalDate(timestamp, 'timestamp');
    assert.array(tickets, 'tickets');

    self.log.info({ tickets: tickets },
        'onUpdate: called with %d tickets', tickets.length);

    async.forEach(
        tickets,
        function _forEachTicket(ticket, next) {
            var i;
            // Check if ticket needs to be expired.
            if (ticket.status !== TICKET_STATUS_FINISHED &&
                       ticket.status !== TICKET_STATUS_EXPIRED &&
                       timestamp &&
                       timestamp.toISOString() > ticket.expires_at) {
                ModelWaitlist.expireTicket(ticket.uuid, function (err) {
                    if (self.callbacks[ticket.uuid]) {
                        self.log.info(
                            'ticket %s expired, invoking %d callbacks',
                            ticket.uuid, self.callbacks[ticket.uuid].length);
                        var expErr = new VError('ticket has expired');
                        for (i in self.callbacks[ticket.uuid]) {
                            self.callbacks[ticket.uuid][i](expErr);
                        }
                        delete self.callbacks[ticket.uuid];
                    }

                    if (err) {
                        self.log.error(err);
                        next(err);
                        return;
                    }
                    next();
                });
                return;
            // Ticket just became active.
            } else if (
                ticket.status === TICKET_STATUS_ACTIVE &&
                self.callbacks[ticket.uuid]) {
                // If ticket went into 'active' status, kick off callbacks
                self.log.info(
                    'ticket %s became active, invoking %d callbacks',
                    ticket.uuid, self.callbacks[ticket.uuid]);
                for (i in self.callbacks[ticket.uuid]) {
                    self.callbacks[ticket.uuid][i]();
                }
                delete self.callbacks[ticket.uuid];
                next();
                return;
            } else if (
                ticket.status === TICKET_STATUS_ACTIVE &&
                !self.callbacks[ticket.uuid]) {
                self.log.warn(
                    { ticket: ticket },
                    'onUpdate: ticket %s active but no callbacks found',
                    ticket.uuid);
            } else {
                self.log.info(
                    { ticket: ticket }, 'nothing to do for ticket %s onUpdate',
                    ticket.uuid);
            }

            next();
    });
};



/*
 * Places a callback on list of callbacks to be called when ticket goes to the
 * 'active' status.
 */

WaitlistDirector.prototype.waitForTicketByUuid =
function ModelWaitlisWaitForTicketByUuid(uuid, callback) {
    var self = this;

    assert.uuid(uuid, 'uuid');
    assert.func(callback, 'callback');

    self.log.info('waitForTicketByUuid: ticket %s', uuid);

    ModelWaitlist.getTicket(uuid, function _onGetTicket(error, result) {
        if (error) {
            callback(new VError('fetching ticket %s', uuid));
            return;
        }

        var ticket = result.ticket;

        // If the ticket doesn't exist, callback with error
        if (!ticket) {
            callback(new VError('no such ticket %s', uuid));
            return;
        }

        if (ticket.status === TICKET_STATUS_ACTIVE) {
            self.log.warn(
                'ticket %s found active', uuid);
             callback();

             return;
        }

        if (ticket.status === TICKET_STATUS_EXPIRED) {
            self.log.warn(
                'ticket %s found expired', uuid);
             callback(new VError('ticket %s is expired', uuid));
             return;
        }

        if (!self.callbacks[uuid]) {
            self.callbacks[uuid] = [];
        }

        self.log.info('setting callback for ticket %s', uuid);

        self.callbacks[uuid].push(once(callback));
    });
};



/**
 * Each instance of ModelWaitlist corresponds to a "waitlist" for a particular
 * server.
 */

function ModelWaitlist(params) {
    assert.object(params, 'params');
    assert.string(params.uuid, 'params.uuid');

    this.uuid = params.uuid; // server uuid
    this.log = ModelWaitlist.getLog().child();
}



ModelWaitlist.createWaitlistDirector = function (params) {
    return new WaitlistDirector(params);
};



ModelWaitlist.init = function (app) {
    var self = this;

    self.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelWaitlist[p] = ModelBase.staticFn[p];
    });

    ModelWaitlist.pendingActivationsByServer = {};
    ModelWaitlist.log = app.getLog();
};


/**
 * Fetch a ticket from moray by given ticket uuid.
 *
 * @param {String} ticket
 * @param callback {Function} `function (err, { ticket: ticket, etag: etag })`
 */

ModelWaitlist.getTicket =
function ModelWaitlistGetTicket(uuid, callback) {
    var self = this;

    assert.uuid(uuid, 'uuid');
    assert.func(callback, 'callback');

    ModelWaitlist.getMoray().getObject(
        MORAY_BUCKET_WAITLIST_TICKETS, uuid, onGet);

    function onGet(error, obj) {
        if (error && VError.hasCauseWithName(error, 'ObjectNotFoundError')) {
            self.log.error('ticket %s not found in moray', uuid);
            callback(null, {});
            return;
        } else if (error) {
            self.log.error(error, 'error fetching ticket from moray');
            callback(error);
            return;
        }

        callback(null, { ticket: obj.value, etag: obj._etag });
    }
};


ModelWaitlist.ticketsUpdatedSince =
function ModelWaitlistTicketsUpdatedSince(opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.optionalDate(opts.timestamp, 'opts.timestamp');
    assert.func(callback, 'callback');

    var filter;
    var findOpts;

    self.log.debug('checking for tickets since %s', opts.timestamp);

    if (opts.timestamp) {
        var ts = new Date(opts.timestamp);
        var escts = common.filterEscape(ts.toISOString());

        // Return any tickets which:
        // - Were updated since the last check and are not finished or expired.
        // - Are not are not marked as finished or expired but have an expiry
        //   date which has been exceeded.
        filter = sprintf(
            '(&' +
                '(!(status=finished))' +
                '(!(status=expired))' +
                '(|(updated_at>=%s)(!(expires_at>=%s)))' +
            ')',
            escts, escts);
    } else {
        filter = '&(!(status=expired))(!(status=finished))';
    }

    findOpts = {
        sort: {
            attribute: 'created_at',
            order: 'ASC'
        }
    };

    self.query(filter, findOpts, function _onQuery(err, tickets) {
        if (err) {
            self.log.error(err);
            callback(new VError(err, 'failed to query moray'));
            return;
        }

        if (tickets.length > 0) {
            self.log.info({ tickets: tickets }, 'new ticket(s)');
        }

        callback(err, tickets);
    });
};


/**
 * Periodically purge old finished/expired waitlist tickets from moray.
 */

WaitlistDirector.cleanupOldTickets = function (log, callback) {
    var ts = Date.now();
    var then = ts - WAITLIST_CLEANUP_MAX_AGE_MS;
    var thenDate = new Date(then);
    var escts = common.filterEscape(thenDate.toISOString());
    log.warn('cleaning up tickets with updated_at older than = %s', escts);

    var filter = sprintf(
        '(&' +
            '(|' +
                '(status=finished)' +
                '(status=expired)' +
            ')' +
            '(!(updated_at>=%s))' +
        ')', escts);

    var moray = ModelWaitlist.getMoray();

    moray.deleteMany(
        MORAY_BUCKET_WAITLIST_TICKETS,
        filter,
        function (error) {
            if (error) {
                callback(error);
                return;
            }

            callback();
        });
};




ModelWaitlist.list = function (params, callback) {
    assert.optionalString(params.server_uuid, 'params.server_uuid');
    assert.optionalNumber(params.limit, 'params.limit');
    assert.optionalNumber(params.offset, 'params.offset');
    assert.optionalString(params.order, 'params.order');
    assert.optionalString(params.attribute, 'params.attribute');

    var uuid = params.server_uuid || '*';
    var queryOpts = {};

    if (params.limit) {
        queryOpts.limit = params.limit;
    }
    if (params.offset) {
        queryOpts.offset = params.offset;
    }
    if (params.order) {
        queryOpts.order = params.order;
    }
    if (params.attribute) {
        queryOpts.attribute = params.attribute;
    }

    ModelWaitlist.query('(server_uuid=' + uuid + ')', queryOpts, callback);
};

/*
 * Do a moray query and return an array of response objects.
 *
 * @param filter {String}
 * @param findOpts {Object}
 * @param callback {Function} `function (err, responses)`
 */

ModelWaitlist.queryWithMeta =
function ModelWaitlistQueryWithMeta(filter, findOpts, callback) {
    var self = this;
    var moray = ModelWaitlist.getMoray();
    var tickets = [];

    // Default sort parameters
    var defaultSort = {
        attribute: 'created_at',
        order: 'ASC',
        limit: 1000,
        offset: 0
    };

    assert.string(filter, 'filter');
    assert.optionalObject(findOpts, 'findOpts');

    if (!callback) {
        callback = findOpts;
        findOpts = {};
    }

    if (!findOpts) {
        findOpts = {};
    }

    assert.func(callback, 'callback');

    var findParams = jsprim.deepCopy(findOpts);
    var sort = findParams.sort || {};
    findParams.sort = jsprim.deepCopy(defaultSort);

    if (sort.limit) {
          findParams.sort.limit = sort.limit;
    }
    if (sort.offset) {
          findParams.sort.offset = sort.offset;
    }
    if (sort.order) {
          findParams.sort.order = sort.order;
    }
    if (sort.attribute) {
          findParams.sort.attribute = sort.attribute;
    }

    try {
        var req = moray.findObjects(
            MORAY_BUCKET_WAITLIST_TICKETS, filter, findParams);
    } catch (e) {
        self.log.warn({ err: e.message }, 'received an exception from moray');
        callback(null, tickets);
        return;
    }

    var oncecb = once(callback);

    if (!req) {
        self.log.warn('Received a null req object from moray');
        callback(null, tickets);
        return;
    }

    function onError(err) {
        self.log.error(err, 'Error retrieving results from moray');
        oncecb(err, tickets);
    }

    function onRecord(ticketres) {
        tickets.push(ticketres);
    }

    function processResults() {
        oncecb(null, tickets);
    }

    req.on('error', onError);
    req.on('record', onRecord);
    req.on('end', processResults);
};


/*
 * Do a moray query and call callback with an array of the `value` property
 * from the responses.
 *
 * @param filter {String}
 * @param findOpts {Object}
 * @param callback {Function} `function (err, values)`
 */

ModelWaitlist.query =
function ModelWaitlistQuery(filter, findOpts, callback) {
    assert.string(filter, 'filter');
    assert.object(findOpts, 'findOpts');
    assert.func(callback, 'callback');

    // Grab the response values.
    ModelWaitlist.queryWithMeta(filter, findOpts,
    function _onQueryWithMeta(err, responses) {
        if (err) {
            callback(err);
            return;
        }
        var values = responses.map(function (r) {
            return r.value;
        });

        callback(null, values);
    });
};


/* BEGIN JSSTYLED */
/*
 * Look up active and queued tickets, given a scope and id. Calls callback with
 * an array of ticket records.
 * Calls `callback` with an array of responses resembling:
 *     {
 *         ticket: ticketObj,
 *         etag: ticketEtagString
 *     }
 *
 * @param opts {Object}
 * @param opts.server_uuid {String} scope/id apply to the server given by this UUID
 * @param opts.scope {String} The ticket scope
 * @param opts.id {String} The id of resource within given scope
 * @param callback {Function} `function (err, responses)`
 */
/* END JSSTYLED */

ModelWaitlist.getServerQueue =
function ModelWaitlistGetServerQueue(opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.string(opts.scope, 'opts.scope');
    assert.string(opts.server_uuid, 'opts.server_uuid');

    // Find all the tickets for a given server, scope, and id. They must be
    // have a status of 'active' or 'queued'.
    var filter = sprintf(
        '(&' +
            '(server_uuid=%s)' +
            '(scope=%s)' +
            '(id=%s)' +
            '(|(status=%s)' +
            '(status=%s))' +
        ')',
        opts.server_uuid, opts.scope, opts.id,
        TICKET_STATUS_ACTIVE, TICKET_STATUS_QUEUED);

    var findOpts = {
        sort: {
            attribute: 'created_at',
            order: 'ASC'
        }
    };

    ModelWaitlist.queryWithMeta(filter, findOpts,
    function _onQueryWithMeta(err, tickets) {
        if (err) {
            callback(new VError(err, 'failed to find next tickets'));
            return;
        }

        var results = tickets.map(function (t) {
            return { ticket: t.value, etag: t._etag };
        });

        self.log.debug({ filter: filter, tickets: results },
            'getServerQueue: found tickets');

        callback(err, results);
    });
};

/*
 * The WaitlistDirector will call this function periodically. This function
 * will look at the `ModelWaitlist.pendingActivationsByServer` object, and
 * iterate over the keys, which are UUIDs of servers which have started, but
 * not yet completed, trying to activate the next ticket in a queue. Each item
 * is an array of objects resembling:
 *
 *   { scope: 'vm', id: 'e8e94f38-3a58-11e9-9148-6362d081387f' }
 *
 * Every time we go to check that a ticket is active for a queue, we add an
 * entry to this object. By doing this, we can make sure we don't get into a
 * situation where we have queue'd tickets but none are active, when they
 * should be.
 *
 * Most of the time, this function should have very little to do. It's only in
 * the situation where we may have an extremely busy datacenter, which could
 * lead to an increased number of etag conflicts, where even with retry/backoff
 * it is possible we could time out and leave no tickets active. We want to
 * make sure even in such a situation, queues are can still make forward
 * progress.
 */

WaitlistDirector.prototype.ensureServerQueuesHaveActiveTickets =
function WaitlistDirectorEnsureServerQueuesHaveActiveTickets(callback) {
    var self = this;
    var pa = ModelWaitlist.pendingActivationsByServer;

    self.log.debug('ensuring tickets for %d servers', Object.keys(pa).length);

    // Iterate over all servers.
    vasync.forEachPipeline({
        inputs: Object.keys(pa),
        func: function _iterActivateServerQueues(server_uuid, next) {
            activateServerQueues(server_uuid, next);
        }
    }, callback);

    function activateServerQueues(server_uuid, cb) {
        // Iterate over all of server's queues (scope/id groups).
        self.log.debug('ensuring tickets for %s (%d queues)',
            server_uuid, pa[server_uuid].length);

        vasync.forEachPipeline({
            inputs: pa[server_uuid],
            func: function _iterActivateQueueTickets(queue, next) {
                var opts = {
                    server_uuid: server_uuid,
                    scope: queue.scope,
                    id: queue.id
                };
                self.log.debug(
                    { queue: opts },
                    'ensureServerQueuesHaveActiveTickets: activation check');
                ModelWaitlist.activateOneTicket(opts, next);
            }
        }, cb);
    }
};


/*
 * Add a server/scope/id to list of waitlist queues that need to be checked
 * periodically for activation.
 * @param opts {Object}
 * @param opts.server_uuid {String} Server UUID
 * @param opts.scope {String} Waitlist scope to match
 * @param opts.id {String} Waitlist id to match
 */

WaitlistDirector.addToPendingActivations =
function WaitlistDirectorAddToPendingActivations(opts) {
    var log = ModelWaitlist.log;
    var pending = ModelWaitlist.pendingActivationsByServer;

    assert.object(opts, 'opts');
    if (opts.server_uuid !== 'default') {
        assert.uuid(opts.server_uuid, 'opts.server_uuid');
    }
    assert.string(opts.scope, 'opts.scope');
    assert.string(opts.id, 'opts.id');

    log.debug('addToPendingActivations: adding %s/%s to %s',
        opts.scope, opts.id, opts.server_uuid);

    if (!pending.hasOwnProperty(opts.server_uuid)) {
        pending[opts.server_uuid] = [];
    }

    // Check if we already have an instance (> 0) of this particular scope/id
    // in the list for this server.
    var foundQueue = (0 < pending[opts.server_uuid].filter(
        function _filterFunc(i) {
            return (i.scope === opts.scope && i.id === opts.id);
        }).length);

    if (!foundQueue) {
        pending[opts.server_uuid].push({ scope: opts.scope, id: opts.id });
    }
};


/*
 * Remove a server/scope/id from the list of waitlist queues that need to be
 * checked periodically for activation.
 *
 * @param opts {Object}
 * @param opts.server_uuid {String} Server UUID
 * @param opts.scope {String} Waitlist scope to match
 * @param opts.id {String} Waitlist id to match
 */

WaitlistDirector.removeFromPendingActivations =
function WaitlistDirectorRemoveFromPendingActivations(opts) {
    var log = ModelWaitlist.log;
    var pending = ModelWaitlist.pendingActivationsByServer;

    assert.object(opts, 'opts');

    if (opts.server_uuid !== 'default') {
        assert.uuid(opts.server_uuid, 'opts.server_uuid');
    }

    assert.string(opts.scope, 'opts.scope');
    assert.string(opts.id, 'opts.id');

    log.debug('removeFromPendingActivations: removing %s/%s from %s',
        opts.scope, opts.id, opts.server_uuid);

    if (!pending.hasOwnProperty(opts.server_uuid)) {
        log.debug('removeFromPendingActivations: '
            + 'wanted to clear up %s but had no record of it',
            opts.scope, opts.id, opts.server_uuid);
        return;
    }

    pending[opts.server_uuid] =
        pending[opts.server_uuid].filter(function _filterFunc(i) {
            return !(i.scope === opts.scope && i.id === opts.id);
        });

    if (pending[opts.server_uuid].length === 0) {
        delete pending[opts.server_uuid];
    }
};


/* BEGIN JSSTYLED */
/*
 * Check if there are tickets with status=`active` for a given `scope`,
 * `server_uuid` and `id`. If none match, take the oldest with
 * `status`='queued' by `created_at` and update its status (to 'active'). Calls
 * `callback` with the UUID of the created ticket as well as the current list
 * of tickets for this server/scope/id.
 *
 * @param opts {Object}
 * @param opts.server_uuid {String} scope/id apply to the server given by this uuid
 * @param opts.scope {String} ticket scope
 * @param opts.id {String} The id of resource within given scope
 * @param callback {Function} `function (err, createdTicketUuid, arrayOfTickets)`
 */
/* END JSSTYLED */

ModelWaitlist.activateOneTicket =
function ModelWaitlistActivateOne(opts, callback) {
    var self = this;
    var ticket;
    var etag;

    assert.object(opts, 'opts');

    if (opts.server_uuid !== 'default') {
        assert.uuid(opts.server_uuid, 'opts.server_uuid');
    }

    assert.string(opts.id, 'opts.id');
    assert.string(opts.scope, 'opts.scope');

    vasync.waterfall([
        function addToPendingActivations(next) {
            WaitlistDirector.addToPendingActivations(opts);
            next();
        },
        function getServerQueue(next) {
            self.log.debug(opts,
                'activateOneTicket: finding next ticket to activate');
            ModelWaitlist.getServerQueue(opts,
            function _onFindNextTickets(err, results) {
                if (err) {
                    next(err);
                    return;
                }

                if (results.length === 0) {
                    self.log.debug(opts,
                        'activateOneTicket: ' +
                        'no tickets found matching criteria');
                    next();
                    return;
                }

                var activeCount = results.filter(function (i) {
                    return i.ticket.status === TICKET_STATUS_ACTIVE;
                }).length;

                if (activeCount > 1) {
                    self.log.error(
                        { opts: opts, results: results },
                        'activateOneTicket: ' +
                        'found more than one active ticket for criteria');
                    next();
                    return;
                }

                if (activeCount > 0) {
                    self.log.debug(opts,
                        'activateOneTicket: ' +
                        'found an active ticket so nothing to do');
                    next();
                    return;
                }

                ticket = results[0].ticket;
                etag = results[0].etag;
                next();
            });
        },
        function activateOldest(next) {
            // If `ticket` is unset, it means we found an active ticket for
            // this queue, so we can remove it from pending activations. We
            // only care about the case when we only have queued tickets.
            if (!ticket) {
                WaitlistDirector.removeFromPendingActivations(opts);
                next();
                return;
            }

            // If `ticket` is set, we have a ticket we need to activate.

            ticket.status = TICKET_STATUS_ACTIVE;
            ticket.updated_at = (new Date()).toISOString();

            ModelWaitlist.getMoray().putObject(
                MORAY_BUCKET_WAITLIST_TICKETS,
                ticket.uuid,
                ticket,
                { etag: etag },
                function _onActivateOnePut(puterror) {
                    if (puterror) {
                        next(VError(puterror, 'failed to updated ticket'));
                        return;
                    }
                    WaitlistDirector.removeFromPendingActivations(opts);
                    next();
                });
        }
    ], callback);
};


/* BEGIN JSSTYLED */
/*
 * Create, update or delete a ticket, and subsequently ensure if there are no
 * active tickets for the same `ticket.scope`, `ticket.server_uuid` and
 * `ticket.id` we take the oldest queued ticket (if any) matching the criteria
 * and make it active.
 *
 * @param {Object} opts
 * @param {Object} opts.operation TICKET_OPERATION_CREATE, TICKET_OPERATION_DELETE, TICKET_OPERATION_UPDATE
 * @param {Object} opts.ticket_uuid
 * @param {Object} opts.ticket Used as the full payload of a new ticket or a partial update to be applied o over an existing ticket
 * @param {Function} callback `function (err)`
 */
/* END JSSTYLED */

ModelWaitlist.ticketOperationActivateNext =
function ModelWaitlistTicketOperation(opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.operation, 'opts.operation');
    assert.uuid(opts.ticket_uuid, 'opts.ticket_uuid');

    if (opts.operation === TICKET_OPERATION_CREATE ||
        opts.operation === TICKET_OPERATION_UPDATE) {
        assert.object(opts.payload, 'opts.payload');
    }

    if (opts.operation === TICKET_OPERATION_CREATE) {
        if (opts.payload.server_uuid !== 'default') {
            assert.optionalUuid(opts.payload.server_uuid,
                'opts.payload.server_uuid');
        }
    }

    assert.func(callback, 'callback');

    // Only care about payload when creating or updating
    if (opts.operation === TICKET_OPERATION_CREATE ||
        opts.operation === TICKET_OPERATION_UPDATE) {

        assert.object(opts.payload, 'opts.payload');
    }

    var ticket_uuid = opts.ticket_uuid;
    var ticket;
    var ticketEtag;

    vasync.waterfall([
        // In the cases of TICKET_OPERATION_DELETE and
        // TICKET_OPERATION_UPDATE we need to look up the existing ticket
        // so that we can submit the etag with the request.
        // In addition, TICKET_OPERATION_UPDATE over-writes a subset of
        // the returned ticket's values when it writes the ticket back to the
        // database.

        function doGetTicket(next) {
            if (opts.operation === TICKET_OPERATION_CREATE) {
                ticket = opts.payload;
                ticketEtag = null;
                next();
                return;
            }

            ModelWaitlist.getTicket(opts.ticket_uuid,
            function _onGetTicket(geterror, result) {
                if (geterror) {
                    next(VError(geterror, 'failed to retrieve ticket %s',
                        ticket_uuid));
                    return;
                }

                if (!result.ticket) {
                    var errorMsg = 'ticket ' + ticket_uuid + ' not found';
                    next(new restify.ResourceNotFoundError(errorMsg));
                    return;
                }

                self.log.debug({ result: result },
                    'ticketOperationActivateNext: getTicket result');

                ticket = result.ticket;
                ticketEtag = result.etag;

                next();
            });
        },

        function doUpdates(next) {
            var morayOpts = { etag: ticketEtag };

            if (opts.operation === TICKET_OPERATION_DELETE) {
                ModelWaitlist.getMoray().delObject(
                    MORAY_BUCKET_WAITLIST_TICKETS,
                    opts.ticket_uuid,
                    morayOpts,
                    function (delError) {
                        if (delError) {
                            next(VError(delError,
                                'failed to delete ticket %s from moray',
                                ticket.uuid));
                            return;
                        }
                        next();
                    });
            } else if (opts.operation === TICKET_OPERATION_UPDATE ||
                       opts.operation === TICKET_OPERATION_CREATE) {

                // Override the ticket values.
                for (var i in opts.payload) {
                    ticket[i] = opts.payload[i];
                }

                ticket.updated_at = (new Date()).toISOString();

                ModelWaitlist.getMoray().putObject(
                    MORAY_BUCKET_WAITLIST_TICKETS,
                    ticket.uuid,
                    ticket,
                    morayOpts,
                    function (putError) {
                        if (putError) {
                            next(VError(putError,
                                'failed to write ticket %s to moray',
                                ticket.uuid));
                            return;
                        }
                        next();
                    });
            } else {
                self.log.error('unknown operation %s', opts.operation);
            }
        },

        // If there are tickets for this server/scope/id, make sure one of them
        // is considered active (having `status` = 'active'). If one is not
        // active, activate the oldest one.
        //
        // We'll wrap this with `backoff` so that if we get an etag conflict we
        // can re-attempt the operation. If we get a conflict and we retry and
        // there is an active ticket now, then can stop, having satisfied our
        // requirement that a ticket be in status='active'.

        function activateOneTicket(next) {
            var call = backoff.call(
                ModelWaitlist.activateOneTicket.bind(self),
                {
                    server_uuid: ticket.server_uuid,
                    scope: ticket.scope,
                    id: ticket.id
                },
                function _onBackoffCall(err) {
                    if (err) {
                        self.log.error(err,
                            'activateOneTicket: returned error');
                    }
                    next();
                });

            call.retryIf(function _onRetryIf(err) {
                return VError.hasCauseWithName(err, 'EtagConflictError');
            });
            call.setStrategy(new backoff.ExponentialStrategy());
            call.failAfter(10);
            call.start();
        }
    ],
    function _onModifyWfEnd(wferr) {
        self.log.debug({ err: wferr }, 'ticketOperationActivateNext: finished');
        callback(wferr);
    });
};


/* BEGIN JSSTYLED */
/*
 * Create a new ticket record. Ticket execution order depends on ticket age
 * (oldest tickets first), grouped by server UUID, scope and id. Tickets are first
 * created with a status of 'queued'. As tickets are released, subsequent
 * tickets are activated (status=active).
 *
 * @param opts {Object}
 * @param opts.scope {String} ticket scope
 * @param opts.id {String} The id of resource within given scope
 * @param opts.expires_at {String} isodate when ticket is considered expired
 * @param opts.action {OptionalString} action associated with this ticket
 * @param opts.req_id {OptionalString} restify request id
 * @param opts.extra {OptionalObject} arbitrary metadata set by caller
 * @param callback {Function} `function (err, createdTicketUuid, currentTicketQueue)`
 */
/* END JSSTYLED */


ModelWaitlist.createTicket =
function ModelWaitlistCreateTicket(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.scope, 'opts.scope');
    assert.string(opts.id, 'opts.id');
    assert.string(opts.expires_at, 'opts.expires_at');
    assert.optionalString(opts.action, 'opts.action');

    if (opts.server_uuid !== 'default') {
        assert.optionalUuid(opts.server_uuid, 'opts.server_uuid');
    }

    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalObject(opts.extra, 'opts.extra');
    assert.func(callback, 'callback');

    var ticket = {
        action: opts.action,
        created_at: (new Date()).toISOString(),
        expires_at: opts.expires_at,
        extra: opts.extra || {},
        id: opts.id,
        reqid: opts.req_id,
        scope: opts.scope,
        server_uuid: opts.server_uuid,
        status: TICKET_STATUS_QUEUED,
        updated_at: (new Date()).toISOString(),
        uuid: libuuid.create()
    };
    var tickets;

    vasync.waterfall([
        function doActivate(next) {
            ModelWaitlist.ticketOperationActivateNext({
                ticket_uuid: ticket.uuid,
                operation: TICKET_OPERATION_CREATE,
                payload: ticket
            }, next);
        },
        function doFind(next) {
            // Look up and return the "next" tickets
            ModelWaitlist.getServerQueue({
                server_uuid: opts.server_uuid,
                scope: opts.scope,
                id: opts.id
            }, function _onFindNextTickets(findErr, _tickets) {
                if (findErr) {
                    next(findErr);
                    return;
                }
                tickets = _tickets.map(function (t) {
                    return t.ticket;
                });
                next();
            });
        }
    ],
    function (err) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, ticket.uuid, tickets);
    });

};

/**
 * Function called when a ticket is has exhausted the lifetime (ie it's
 * expires_at timestamp is now in the past).
 */


ModelWaitlist.expireTicket =
function ModelWaitlistExpireTicket(ticket_uuid, callback) {
    var self = this;

    assert.string(ticket_uuid, 'ticket_uuid');

    self.log.info({ uuid: ticket_uuid }, 'going to expire ticket');

    ModelWaitlist.ticketOperationActivateNext({
        ticket_uuid: ticket_uuid,
        operation: TICKET_OPERATION_UPDATE,
        payload: {
            status: TICKET_STATUS_EXPIRED
        }
    }, callback);
};


/*
 * Release an active waitlist ticket, and allow and subsequent tickets for the
 * same scope/id combination to be activated. The status for the given ticket
 * will be set as 'finished'.
 *
 * @param ticket_uuid {String} The ticket to be released.
 * @param callback {Function} `function (err)`
 */

ModelWaitlist.releaseTicket =
function ModelWaitlistReleaseTicket(ticket_uuid, callback) {
    var self = this;

    assert.string(ticket_uuid, 'ticket_uuid');

    self.log.info({ uuid: ticket_uuid }, 'going to release ticket');

    ModelWaitlist.ticketOperationActivateNext({
        ticket_uuid: ticket_uuid,
        operation: TICKET_OPERATION_UPDATE,
        payload: {
            status: TICKET_STATUS_FINISHED
        }
    }, callback);
};


/*
 * Delete a waitlist ticket, and allow and subsequent tickets for the same
 * scope/id combination to be activated. The status for the given ticket will
 * be set as 'finished'.
 *
 * @param ticket_uuid {String} The ticket to be released.
 * @param callback {Function} `function (err)`
 */

ModelWaitlist.deleteTicket =
function ModelWaitlistDeleteTicket(ticket_uuid, callback) {
    var self = this;

    assert.string(ticket_uuid, 'ticket_uuid');

    self.log.info({ uuid: ticket_uuid }, 'going to delete ticket');

    ModelWaitlist.ticketOperationActivateNext({
        ticket_uuid: ticket_uuid,
        operation: TICKET_OPERATION_DELETE
    }, callback);
};


ModelWaitlist.prototype.deleteAllTickets = function (callback) {
    var self = this;

    var done = false;

    async.whilst(
        function () { return !done; },
        onIteration, onDone);

    function onIteration(wlcb) {
        vasync.waterfall([
            function (wfcb) {
                ModelWaitlist.getMoray().deleteMany(
                    MORAY_BUCKET_WAITLIST_TICKETS,
                    '(server_uuid=' + self.uuid + ')',
                    function (delError) {
                        if (delError) {
                            self.log.error({
                                err: delError
                            }, 'Error when deleting tickets');
                            wfcb(delError);
                            return;
                        }

                        wfcb();
                        return;
                    });
            },
            function (wfcb) {
                self.countTickets(function (err, ticketCount) {
                    if (err) {
                        self.log.error({
                            err: err
                        }, 'Error when counting tickets');
                        wfcb(err);
                        return;
                    }

                    self.log.debug({
                        ticketCount: ticketCount
                    }, 'Tickets count after delete iteration');

                    if (ticketCount === 0) {
                        done = true;
                    }

                    wfcb();
                    return;
                });
            }
        ],
        function (err) {
            wlcb(err);
        });
    }

    function onDone(err) {
        callback(err);
    }
};


ModelWaitlist.prototype.countTickets = function (callback) {
    var self = this;

    var sql = 'SELECT count(1)' +
              'FROM cnapi_waitlist_tickets ' +
              'WHERE server_uuid=$1';
    var count;

    var oncecb = once(callback);

    var req = ModelWaitlist.getMoray().sql(sql, [self.uuid], {});
    req.once('record', function (r) {
        count = parseInt(r.count, 10);
    });
    req.once('error', function (err) {
        oncecb(err);
    });

    req.once('end', function () {
        oncecb(null, count);
    });
};


module.exports = ModelWaitlist;
