/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * The waitlist subsystem is responsible for serializing access to datacenter
 * resources.
 *
 * See the "Waitlist" section in docs/index.md for more information.
 */

var assert = require('assert-plus');
var async = require('async');
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
var TICKET_OPERATION_UPDATE = 'update';
var TICKET_OPERATION_DELETE = 'delete';

// Moray bucket
var MORAY_BUCKET_WAITLIST_TICKETS = buckets.waitlist_tickets.name;

// How long, (in ms), between checks to moray for ticket updates
var WAITLIST_PERIOD_MS = 500;

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


/*
 * Look up in moray which tickets should be activated next, given a scope and
 * id. Calls callback with active and queued tickets.
 *
 * @param opts {Object}
 * @param opts.scope {String} The ticket scope
 * @param opts.id {String} The id of resource within given scope
 * @param callback {Function} `function (err, responses)`
 */

ModelWaitlist.findNextTickets =
function modelWaitlistFindNextTickets(opts, callback) {
    var self = this;

    assert.string(opts.id, 'opts.id');
    assert.string(opts.scope, 'opts.scope');
    assert.string(opts.server_uuid, 'opts.server_uuid');
    assert.optionalNumber(opts.limit, 'opts.limit');
    assert.optionalBool(opts.omitActive, 'opts.omitActive');
    assert.optionalUuid(opts.omitTicketUuid, 'opts.omitTicketUuid');

    var filter = sprintf(
        '(&' +
            '(server_uuid=%s)' +
            '(scope=%s)' +
            '(id=%s)' +
            (opts.omitActive ? '(!(status=active))' : '') +
            (opts.omitTicketUuid
                ? '(!(uuid=' + opts.omitTicketUuid + '))' : '') +
            '(!(status=finished))' +
            '(!(status=expired))' +
        ')', opts.server_uuid, opts.scope, opts.id);

    var findOpts = {
        limit: opts.limit,
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

        tickets = tickets.map(function (t) {
            return { ticket: t.value, etag: t._etag };
        });

        self.log.trace({ filter: filter, tickets: tickets },
            'findNextTickets: found tickets');

        callback(err, tickets);
    });
};

/*
 * Update a ticket in moray, and activate the next ticket (by creation_date)
 * with the same set formed by `ticket.scope`, `ticket.server_uuid`, and
 * `ticket.id`.
 *
 * @param {Object} opts
 * @param {Object} opts.ticket
 * @param {String} opts.ticketEtag
 * @param {Function} callback `function (err, { ticket: ticket, etag: etag })`
 */

ModelWaitlist.modifyTicketActivateNext =
function ModelWaitlistUpdateTicketActivateNext(opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.operation, 'opts.operation');
    assert.uuid(opts.ticket_uuid, 'opts.ticket_uuid');
    assert.func(callback, 'callback');

    if (opts.operation === TICKET_OPERATION_UPDATE) {
        assert.object(opts.update, 'opts.update');
    }

    var moray = ModelWaitlist.getMoray();

    var ticket_uuid = opts.ticket_uuid;
    var ticket;
    var ticketEtag;
    var batchOperations = [];

    vasync.waterfall([
        // Look up ticket with given ticket uuid.
        function doGetTicket(next) {
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
                    'modifyTicketActivateNext: getTicket result');

                ticket = result.ticket;
                ticketEtag = result.etag;
                ticket.updated_at = (new Date()).toISOString();

                // If update passed in, override the ticket values with it.
                if (opts.update) {
                    for (var i in opts.update) {
                        ticket[i] = opts.update[i];
                    }
                }

                next();
            });
        },

        // Set up batch call to delete or update ticket for given ticket uuid
        // depending on operation.
        function doSetupBatch(next) {
            if (opts.operation === TICKET_OPERATION_DELETE) {
                batchOperations.push({
                    bucket: MORAY_BUCKET_WAITLIST_TICKETS,
                    key: ticket.uuid,
                    operation: 'delete',
                    options: {
                        etag: ticketEtag
                    }
                });
            } else if (opts.operation === TICKET_OPERATION_UPDATE) {
                batchOperations.push({
                    bucket: MORAY_BUCKET_WAITLIST_TICKETS,
                    key: ticket.uuid,
                    operation: 'put',
                    value: ticket,
                    options: {
                        etag: ticketEtag
                    }
                });
            } else {
                self.log.error('unknown operation %s', opts.operation);
            }

            self.log.info({ operation: opts.operation,
                batchData: batchOperations },
                'updateTicketActivateNext: batch batchOperations');

            next();
        },

        // Look up the next ticket to be activated so we can activate it at
        // the same time as we update/delete the ticket that was passed in.
        function doFindNextTicket(next) {
            ModelWaitlist.findNextTickets({
                server_uuid: ticket.server_uuid,
                limit: 1,
                omitActive: true,
                omitTicketUuid: ticket.uuid,
                id: ticket.id,
                scope: ticket.scope
            },
            function onFindTicket(err, results) {
                if (err) {
                    next(err);
                    return;
                }

                // If there are no more tickets to activate we can skip
                // everything after this.
                if (!results.length) {
                    next();
                    return;
                }

                var nextTicket = results[0].ticket;
                var nextEtag = results[0].etag;

                // If there was a subsequent ticket to our given one waiting
                // to be activated, update its values and write it back out.
                // Otherwise, we can skip this part.

                if (!nextTicket) {
                    self.log.info('no ticket following update of %s',
                        ticket.uuid);
                    next();
                    return;
                }

                nextTicket.updated_at = (new Date()).toISOString();
                nextTicket.status = TICKET_STATUS_ACTIVE;

                self.log.info({ nextTicket: nextTicket },
                    'ticket to be activated');

                batchOperations.push({
                    bucket: MORAY_BUCKET_WAITLIST_TICKETS,
                    key: nextTicket.uuid,
                    operation: 'put',
                    value: nextTicket,
                    options: {
                        etag: nextEtag
                    }
                });
                next();
            });
        },

        // Actually execute the batch.
        function batchUpdate(next) {
            self.log.debug({
                batch: batchOperations
            }, 'performing batch operation to activate next ticket');

            moray.batch(batchOperations, function (err, _meta) {
                if (err &&
                    (VError.hasCauseWithName(err,
                        'EtagConflictError') ||
                    (VError.hasCauseWithName(err,
                        'UniqueAttributeError')))) {

                    self.log.warn({ err: err },
                        'modifyTicketActivateNext: batch conflict, retrying');

                    self.modifyTicketActivateNext(opts, next);
                    return;
                } else if (err) {
                    next(new VError(err,
                        'updateTicketActivateNext: batch error'));
                    return;
                }

                next();
            });
        }
    ],
    function (wferr) {
        self.log.info({ err: wferr }, 'updateTicketActivateNext: finished');
        callback(wferr);
    });
};


/* BEGIN JSSTYLED */
/*
 * Create a new ticket record and write it into moray. If there are existing
 * tickets for the same `server_uuid`, `scope` and `id`, the new ticket will
 * receive a status of 'queued'.
 *
 * @param opts {Object}
 * @param opts.scope {String} ticket scope
 * @param opts.id {String} The id of resource within given scope
 * @param opts.expires_at {String} isodate when ticket is considered expired
 * @param opts.action {OptionalString} action associated with this ticket
 * @param opts.req_id {OptionalString} restify request id
 * @param opts.extra {OptionalObject} arbitrary metadata set by caller
 * @param callback {Function} `function (err, createdTicketUuid)`
 */
/* END JSSTYLED */

ModelWaitlist.prototype.createTicket =
function ModelWaitlistCreateTicket(opts, callback) {
    var self = this;

    assert.object(opts, 'opts');
    assert.string(opts.scope, 'opts.scope');
    assert.string(opts.id, 'opts.id');
    assert.string(opts.expires_at, 'opts.expires_at');
    assert.optionalString(opts.action, 'opts.action');
    assert.optionalString(opts.req_id, 'opts.req_id');
    assert.optionalObject(opts.extra, 'opts.extra');
    assert.func(callback, 'callback');

    var ticket = {
        uuid: libuuid.create(),
        server_uuid: this.uuid,
        scope: opts.scope,
        id: opts.id,
        expires_at: opts.expires_at,
        created_at: (new Date()).toISOString(),
        updated_at: (new Date()).toISOString(),
        reqid: opts.req_id,
        extra: opts.extra || {}
    };


    if (jsprim.hasKey(opts, 'action')) {
        ticket.action = opts.action;
    }

    self.log.info({
        ticket: ticket
    }, 'creating ticket %s', ticket.uuid);

    var tickets;

    vasync.waterfall([
        /*
         * Check if there are existing tickets for this server/scope/id
         * combination. If there are, we'll set this ticket's status to
         * 'queued'. If there are no currently queued or active tickets, we'll
         * make this one 'active'.
         */
        function determineWhetherToActivate(next) {
            ModelWaitlist.findNextTickets({
                server_uuid: self.uuid,
                scope: opts.scope,
                id: opts.id
            }, function _onDetermineWhetherToActivate(err, _tickets) {
                if (err) {
                    next(err);
                    return;
                }

                tickets = _tickets.map(function (t) {
                    return t.ticket;
                });

                if (tickets.length) {
                    ticket.status = TICKET_STATUS_QUEUED;
                } else {
                    ticket.status = TICKET_STATUS_ACTIVE;
                }
                next();
            });
        },

        /*
         * Write this ticket object out to moray.
         */
        function writeTicketToMoray(next) {
            ModelWaitlist.getMoray().putObject(
                MORAY_BUCKET_WAITLIST_TICKETS,
                ticket.uuid,
                ticket,
                function (puterror) {
                    if (puterror) {
                        next(VError(puterror,
                            'failed to write ticket %s to moray',
                            ticket.uuid));
                        return;
                    }
                    next();
                });
        },
        /*
         * Finally, look up the ticket queue one more time, and return it to
         * the caller.
         */

        function refreshTickets(next) {
            ModelWaitlist.findNextTickets({
                server_uuid: self.uuid,
                scope: opts.scope,
                id: opts.id
            }, function _onFindNextTickets(err, _tickets) {
                if (err) {
                    next(err);
                    return;
                }

                tickets = _tickets.map(function (t) {
                    return t.ticket;
                });
                next();
            });
        }
    ],
    function endWaterfall(wferror) {
        callback(wferror, ticket.uuid, tickets);
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

    ModelWaitlist.modifyTicketActivateNext({
        ticket_uuid: ticket_uuid,
        operation: TICKET_OPERATION_UPDATE,
        update: {
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

    ModelWaitlist.modifyTicketActivateNext({
        ticket_uuid: ticket_uuid,
        operation: TICKET_OPERATION_UPDATE,
        update: {
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

    ModelWaitlist.modifyTicketActivateNext({
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



ModelWaitlist.prototype.updateTicket = function (uuid, params, callback) {
    ModelWaitlist.getTicket(uuid, function (geterror, result) {
        if (geterror) {
            callback(
                VError(geterror, 'failed to retrieve ticket %s', uuid));
            return;
        }

        var ticket = result.ticket;

        if (params.status) {
            ticket.status = params.status;
        }

        ticket.updated_at = (new Date()).toISOString();

        ModelWaitlist.getMoray().putObject(
            MORAY_BUCKET_WAITLIST_TICKETS,
            uuid,
            ticket,
            function (puterror) {
                if (puterror) {
                    callback(
                        VError(puterror, 'failed to store updated ticket'));
                    return;
                }
                callback();
            });
    });
};



module.exports = ModelWaitlist;
