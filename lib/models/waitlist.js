/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * CNAPI wailist subsystem for serializing server operations.
 * See docs/waitlist.md for more details.
 */

var assert = require('assert-plus');
var async = require('async');
var libuuid = require('libuuid');
var once = require('once');
var sprintf = require('sprintf').sprintf;
var vasync = require('vasync');
var VError = require('verror');
var jsprim = require('jsprim');

var ModelBase = require('./base');
var buckets = require('../apis/moray').BUCKETS;
var common = require('../common');
var orderedKVString = require('../common').orderedKVString;


// how long, (in ms), between checks to moray for ticket updates
var WAITLIST_PERIOD_MS = 500;

// how long, (in ms), between attempts to clean old tickets out of moray
var WAITLIST_CLEANUP_PERIOD_MS = 3600 * 1000;

// when cleanup occurs, delete tickets that are past this threshold (1mo)
var WAITLIST_CLEANUP_MAX_AGE_MS = 3600 * 24 * 30 * 1000;

/**
 * The WaitlistDirector is the active component of the CNAPI waitlist
 * functionality. It periodically checks moray for waitlist tickets that have
 * been updated and takes appropriate action, such as: dispatching wait
 * callbacks and updating ticket statuses.
 *
 * There will only be one instance of this per CNAPI process.
 */

function WaitlistDirector(params) {
    var self = this;
    self.params = params;
    self.log = WaitlistDirector.log;
    self.callbacks = {};
}



/**
 * Begins checking moray for ticket updates and taking action based on changes
 * therein.
 */

WaitlistDirector.prototype.start = function () {
    var self = this;

    var lastCheck;
    var start = new Date();

    self.log.info('starting WaitlistDirector');

    if (!WaitlistDirector.timeout) {
        clearInterval(WaitlistDirector.timeout);
    }

    WaitlistDirector.timeout = setTimeout(intervalFn, WAITLIST_PERIOD_MS);
    WaitlistDirector.cleanupTimeout = setTimeout(cleanupIntervalFn,
                                                 WAITLIST_CLEANUP_PERIOD_MS);

    function intervalFn() {
        var params = { timestamp: lastCheck && new Date(lastCheck - 1000) };
        start = new Date();
        ModelWaitlist.ticketsUpdatedSince(params, onTicketsUpdated);
    }

    function cleanupIntervalFn() {
        WaitlistDirector.cleanupOldTickets(onTicketsCleanedUp);
    }

    function onTicketsUpdated(error, tickets) {
        if (error) {
            self.log.error(
                { error: error }, 'failed to get tickets since %s',
                lastCheck);
        }

        var date = lastCheck;
        lastCheck = new Date();

        if (!tickets || !tickets.length) {
            self.log.trace('no tickets updated since %s',
                       date ? date.toISOString() : 'start-up',
                       start.toISOString());
            // No updated tickets need attention
            WaitlistDirector.timeout = setTimeout(intervalFn,
                                                  WAITLIST_PERIOD_MS);
            return;
        }

        self.log.info({ tickets: tickets },
                       'tickets updated since %s (started at %s)',
                       date ? date.toISOString() : 'start-up',
                       start.toISOString());

        self.onUpdate(date, tickets);

        WaitlistDirector.timeout = setTimeout(intervalFn, WAITLIST_PERIOD_MS);
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
 * Call with a timestamp and list of tickets that have had their `updated_at`
 * value updated since last we checked. This will dispatch callbacks for
 * "wait" on ticket status going to "expire" or "finished", and make sure that
 * any tickets in which now() > `expires_at` get marked as 'expired'.
 */

WaitlistDirector.prototype.onUpdate = function (timestamp, tickets) {
    var self = this;
    self.log.trace('onUpdate with %d tickets', tickets.length);
    async.forEach(
        tickets,
        function (ticket, fecb) {
            var i;
            // Check if ticket needs to be expired.
            if (ticket.status === 'expired' &&
                self.callbacks[ticket.uuid])
            {
                self.log.info(
                    'ticket %s expired, invoking %d callbacks',
                    ticket.uuid, self.callbacks[ticket.uuid].length);
                // If ticket went into 'active' status, kick off callbacks.
                for (i in self.callbacks[ticket.uuid]) {
                    self.callbacks[ticket.uuid][i](
                        new VError('ticket has expired'));
                }
                delete self.callbacks[ticket.uuid];
                fecb();
                return;
            // Check if a pending (active/queued) ticket is expired but not
            // marked as such.
            } else if (ticket.status !== 'finished' &&
                       timestamp &&
                       timestamp.toISOString() > ticket.expires_at)
            {
                var wl = new ModelWaitlist({ uuid: ticket.server_uuid });
                wl.expireTicket(ticket.uuid, function (err) {
                    if (err) {
                        self.log.error(err);
                        return;
                    }
                    fecb();
                });
                return;
            // Ticket just became active.
            } else if (
                ticket.status === 'active' &&
                self.callbacks[ticket.uuid])
            {
                // If ticket went into 'active' status, kick off callbacks
                self.log.info(
                    'ticket %s became active, invoking %d callbacks',
                    ticket.uuid, self.callbacks[ticket.uuid]);
                for (i in self.callbacks[ticket.uuid]) {
                    self.callbacks[ticket.uuid][i]();
                }
                delete self.callbacks[ticket.uuid];
                fecb();
                return;
            } else if (
                ticket.status === 'active' &&
                !self.callbacks[ticket.uuid])
            {
                self.log.warn(
                    { ticket: ticket },
                    'onUpdate: ticket %s active but no callbacks found',
                    ticket.uuid);
            } else {
                self.log.info(
                    { ticket: ticket }, 'nothing to do for ticket %s onUpdate',
                    ticket.uuid);
            }

            fecb();
    });
};



/*
 * Places a callback on list of callbacks to be called when ticket goes to the
 * 'active' status.
 */

WaitlistDirector.prototype.waitForTicketByUuid = function (uuid, callback) {
    var self = this;

    self.log.info('waitForTicketByUuid: ticket %s', uuid);

    ModelWaitlist.getTicket(uuid, function (error, t) {
        if (error) {
            callback(new VError('fetching ticket %s', uuid));
            return;
        }

        // If the ticket doesn't exist in moray, it doesn't exist period.
        if (!t) {
            callback(new VError('no such ticket %s', uuid));
            return;
        }

        if (t.status === 'active') {
            self.log.warn(
                'ticket %s found active', uuid);
             callback();
             return;
        }

        if (t.status === 'expired') {
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
    var self = ModelWaitlist;
    self.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelWaitlist[p] = ModelBase.staticFn[p];
    });

    ModelWaitlist.log = app.getLog();
    WaitlistDirector.log = app.getLog();
};



ModelWaitlist.ticketsUpdatedSince = function (params, callback) {
    var self = ModelWaitlist;
    var filter;

    self.log.trace('checking for tickets since %s', params.timestamp);

    if (params.timestamp) {
        var ts = new Date(params.timestamp);
        var escts = common.filterEscape(ts.toISOString());

        filter = sprintf(
            // Return any tickets which:
            '(|' +
                // - are not finished|expired and have been updated since the
                //   last check.
                '(&' +
                    '(!(status=finished))' +
                    '(!(status=expired))' +
                    '(updated_at>=%s)' +
                ')' +
                // - are not are not marked as finished or expired but have an
                //   expiry date which has been exceeded.
                '(&' +
                    '(!(status=finished))' +
                    '(!(status=expired))' +
                    '(!(expires_at>=%s))' +
                '))',
            escts, escts);
    } else {
        filter = '&(!(status=expired))(!(status=finished))';
    }

    var findOpts = {
        sort: {
            attribute: 'created_at',
            order: 'DESC'
        }
    };

    self.query(filter, findOpts, function (err, tickets) {
        if (!err && tickets.length > 0) {
            self.log.info({ tickets: tickets }, 'new ticket(s)');
        }

        callback(err, tickets);
    });
};


/**
 * Periodically purge old finished/expired waitlist tickets from moray.
 */

WaitlistDirector.cleanupOldTickets = function (callback) {
    var self = this;
    var ts = Date.now();
    var then = ts - WAITLIST_CLEANUP_MAX_AGE_MS;
    var thenDate = new Date(then);
    var escts = common.filterEscape(thenDate.toISOString());
    self.log.warn('cleaning up tickets with updated_at older than = %s', escts);

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
        buckets.waitlist_tickets.name,
        filter,
        function (error) {
            if (error) {
                callback(error);
                return;
            }

            callback();
        });
};


ModelWaitlist.ticketRelease = function (ticket_uuid, callback) {
    var self = ModelWaitlist;
    // Steps to release a ticket:
    // Batch
    //   - confirm ticket status to see if there is any actual work to be done
    //   - confirm queue status to see if there is any actual work to be done
    //
    // Batch:
    //   - put ticket status => 'finished', updated_at times
    //   - remove ticket from queue
    //   - update next ticket's status => active if it is first

    var ticket;
    var serverqueue;
    var etag;
    var wl;

    vasync.waterfall([
        function (wfcb) {
            ModelWaitlist.getTicket(ticket_uuid,
                function (geterror, respticket) {
                    if (geterror) {
                        wfcb(VError(geterror, 'failed to load ticket %s',
                                    ticket_uuid));
                        return;
                    }

                    if (!respticket) {
                        wfcb(VError('no such ticket %s', ticket_uuid));
                        return;
                    }

                    ticket = respticket;
                    wfcb();
                });
        },
        function (wfcb) {
            wl = new ModelWaitlist({ uuid: ticket.server_uuid });
            wl.getServerQueue(function (err, respserverqueue, res) {
                if (err) {
                    wfcb(VError(err, 'loading waitlist queue for server %s',
                        ticket.server_uuid));
                    return;
                }

                serverqueue = respserverqueue;
                etag = res.etag;

                wfcb();
            });
        },
        function (wfcb) {
            self.log.info(
                'ticket %s released; activating next if any', ticket.uuid);
            wl.finishTicketUpdateQueueActivateNext(
                ticket, serverqueue, etag, wfcb);
        }
    ],
    function (err) {
        callback(err);
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



ModelWaitlist.query = function (filter, findOpts, callback) {
    assert.optionalObject(findOpts, 'findOpts');

    var self    = ModelWaitlist;
    var moray   = ModelWaitlist.getMoray();
    var bucket  = buckets.waitlist_tickets.name;
    var tickets = [];

    // Default sort parameters
    var defaultSort = {
        attribute: 'created_at',
        order: 'ASC',
        limit: 1000,
        offset: 0
    };

    if (!callback) {
        callback = findOpts;
        findOpts = {};
    }

    if (!findOpts) {
        findOpts = {};
    }

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
        var req = moray.findObjects(bucket, filter, findParams);
    } catch (e) {
        self.log.warn({ err: e.message }, 'Received an exception from moray');
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

    function onRecord(ticket) {
        tickets.push(ticket.value);
    }

    function processResults() {
        oncecb(null, tickets);
    }

    req.on('error', onError);
    req.on('record', onRecord);
    req.on('end', processResults);
};



ModelWaitlist.getTicket = function (uuid, callback) {
    var self = ModelWaitlist;

    ModelWaitlist.getMoray().getObject(
        buckets.waitlist_tickets.name, uuid, onGet);

    function onGet(error, obj) {
        if (error && VError.hasCauseWithName(error, 'ObjectNotFoundError')) {
            self.log.error('Ticket %s not found in moray', uuid);
            callback();
            return;
        } else if (error) {
            self.log.error(error, 'Error fetching ticket from moray');
            callback(error);
            return;
        }

        callback(null, obj.value);
    }
};



ModelWaitlist.prototype.getServerQueue = function (callback) {
    var self = this;
    var serverqueue;
    var etag;

    ModelWaitlist.getMoray().getObject(
        buckets.waitlist_queues.name,
        self.uuid,
        function (err, response) {
            var res = { etag: null };
            if (err && VError.hasCauseWithName(err, 'ObjectNotFoundError')) {
                self.log.error(
                    'Ticket queue for %s not found in moray',
                    self.uuid);
                callback(null, null, res);
                return;
            } else if (err) {
                self.log.error(
                    err, 'Error fetching ticket from moray');
                callback(err);
                return;
            }
            serverqueue = response.value;
            if (response) {
                etag = response._etag;
            }
            callback(null, serverqueue, { etag: etag });
        });
};



/**
 * Check if the waitlist queue for this server exists, and create it if it
 * does not. Returns the queue object value and etag.
 */

ModelWaitlist.prototype.ensureServerQueue = function (callback) {
    var self = this;
    var serverqueue = null;
    var etag = null;
    var moray = ModelWaitlist.getMoray();

    vasync.waterfall([
        function (wfcb) {
            self.getServerQueue(function (err, s, res) {
                if (err) {
                    wfcb(err);
                    return;
                }

                serverqueue = s;
                etag = res.etag;
                wfcb();
            });

        },
        function (wfcb) {
            if (serverqueue) {
                wfcb();
                return;
            }

            serverqueue = {
                server_uuid: self.uuid,
                updated_at: (new Date()).toISOString(),
                tickets: {}
            };

            moray.putObject(
                buckets.waitlist_queues.name,
                self.uuid,
                serverqueue,
                { etag: etag },
                function (err, response) {
                    if (err &&
                       (VError.hasCauseWithName(err, 'EtagConflictError') ||
                       (VError.hasCauseWithName(err, 'UniqueAttributeError'))))
                    {
                        self.log.warn({ err: err },
                            'waitlist collision on queue initialization, ' +
                            'retrying');

                        process.nextTick(function () {
                            self.ensureServerQueue(wfcb);
                        });
                        return;
                    }

                    wfcb();
                    return;
                });
        }
    ],
    function (err) {
        callback(err, { etag: etag, serverqueue: serverqueue });
    });
};



ModelWaitlist.prototype.removeTicketUpdateQueueActivateNext =
function (ticket, serverqueue, etag, callback) {
    var self = this;
    var key = orderedKVString({ id: ticket.id, scope: ticket.scope });

    if (!serverqueue.tickets[key]) {
        serverqueue.tickets[key] = [];
    }

    ticket.created_at =
    serverqueue.updated_at =
        (new Date()).toISOString();

    var queue = serverqueue.tickets[key];
    var ticketIdx = queue.indexOf(ticket.uuid);
    var wasTop = (ticketIdx === 0 ? true : false);

    var data = [
        {
            bucket: buckets.waitlist_tickets.name,
            key: ticket.uuid,
            operation: 'delete'
        }
    ];

    // if ticket is in serverqueue
    if (ticketIdx !== -1) {
        data.push({
            bucket: buckets.waitlist_queues.name,
            key: self.uuid,
            value: serverqueue,
            options: {
                etag: etag
            }
        });
    }

    queue.splice(ticketIdx, ticketIdx+1);
    serverqueue.tickets[key] = queue;

    Object.keys(serverqueue.tickets).forEach(function (k) {
        if (!serverqueue.tickets[k].length) {
            delete serverqueue.tickets[k];
        }
    });

    var moray = ModelWaitlist.getMoray();

    // We have removed the 'finished' ticket, if there is another ticket in the
    // queue, now we need to mark the "top" ticket as active, and then write
    // back the updated queue.
    vasync.waterfall([
        function (wfcb) {
            if (queue.length && wasTop) {
                ModelWaitlist.getTicket(queue[0],
                    function (geterror, respticket) {
                        if (geterror) {
                            wfcb(geterror);
                            return;
                        }
                        var nextticket = respticket;

                        nextticket.updated_at = (new Date()).toISOString();
                        nextticket.status = 'active';

                        data.push({
                            bucket: buckets.waitlist_tickets.name,
                            key: queue[0],
                            value: nextticket
                        });
                        wfcb();
                    });
                return;
            }
            wfcb();
        },
        function (wfcb) {
            moray.batch(data, function (err, meta) {
                if (err &&
                   (VError.hasCauseWithName(err, 'EtagConflictError') ||
                   (VError.hasCauseWithName(err, 'UniqueAttributeError'))))
                {
                    process.nextTick(function () {
                        self.ensureServerQueue(function (err2, resp) {
                            if (err2) {
                                wfcb(err2);
                                return;
                            }
                            self.pushTicketUpdateQueue(
                                ticket,
                                resp.serverqueue,
                                resp.etag, wfcb);
                        });
                    });
                    return;
                } else {
                    wfcb();
                }
            });
        }
    ],
    function (wferr) {
        callback(wferr);
    });
};



/**
 * Expire a ticket given a ticket payload and a server queue object.
 */

ModelWaitlist.prototype.expireTicketUpdateQueueActivateNext =
function (ticket, serverqueue, etag, callback) {
    var self = this;
    var key = orderedKVString({ id: ticket.id, scope: ticket.scope });

    if (!serverqueue.tickets[key]) {
        serverqueue.tickets[key] = [];
    }

    ticket.status = 'expired';
    ticket.updated_at =
    serverqueue.updated_at =
        (new Date()).toISOString();

    var queue = serverqueue.tickets[key];
    var ticketIdx = queue.indexOf(ticket.uuid);
    var wasTop = (ticketIdx === 0 ? true : false);

    var data = [
        {
            bucket: buckets.waitlist_tickets.name,
            key: ticket.uuid,
            operation: 'put',
            value: ticket
        }
    ];

    // if ticket is in serverqueue
    if (ticketIdx !== -1) {
        data.push({
            bucket: buckets.waitlist_queues.name,
            key: self.uuid,
            value: serverqueue,
            options: {
                etag: etag
            }
        });
    }

    queue.splice(ticketIdx, ticketIdx+1);
    serverqueue.tickets[key] = queue;

    Object.keys(serverqueue.tickets).forEach(function (k) {
        if (!serverqueue.tickets[k].length) {
            delete serverqueue.tickets[k];
        }
    });

    var moray = ModelWaitlist.getMoray();

    // We have removed the 'expired' ticket, if there is another ticket in the
    // queue, now we need to mark the "top" ticket as active, and then write
    // back the updated queue.
    vasync.waterfall([
        function (wfcb) {
            if (queue.length && wasTop) {
                ModelWaitlist.getTicket(queue[0],
                    function (geterror, respticket) {
                        if (geterror) {
                            wfcb(geterror);
                            return;
                        }
                        var nextticket = respticket;

                        nextticket.updated_at = (new Date()).toISOString();
                        nextticket.status = 'active';

                        data.push({
                            bucket: buckets.waitlist_tickets.name,
                            key: queue[0],
                            value: nextticket
                        });
                        wfcb();
                    });
                return;
            }
            wfcb();
        },
        function (wfcb) {
            self.log.debug({
                batch: data
            }, 'performing batch operation to activate next ticket');
            moray.batch(data, function (err, meta) {
                if (err) {
                    self.log.error({
                        err: err
                    }, 'Error when performing batch operation');
                }

                if (err &&
                   (VError.hasCauseWithName(err, 'EtagConflictError') ||
                   (VError.hasCauseWithName(err, 'UniqueAttributeError'))))
                {
                    process.nextTick(function () {
                        self.ensureServerQueue(function (err2, resp) {
                            if (err2) {
                                wfcb(err2);
                                return;
                            }

                            self.log.debug('retrying ' +
                                'expireTicketUpdateQueueActivateNext');
                            self.expireTicketUpdateQueueActivateNext(
                                ticket,
                                resp.serverqueue,
                                resp.etag, wfcb);
                        });
                    });
                    return;
                } else {
                    wfcb();
                }
            });
        }
    ],
    function (wferr) {
        callback(wferr);
    });
};



ModelWaitlist.prototype.finishTicketUpdateQueueActivateNext =
function (ticket, serverqueue, etag, callback) {
    var self = this;
    var key = orderedKVString({ id: ticket.id, scope: ticket.scope });

    if (!serverqueue.tickets[key]) {
        serverqueue.tickets[key] = [];
    }

    ticket.status = 'finished';
    ticket.updated_at = serverqueue.updated_at = (new Date()).toISOString();

    var queue = serverqueue.tickets[key];
    var ticketIdx = queue.indexOf(ticket.uuid);

    /**
     * Craft the payload we will submit to moray.batch()
     *
     * This includes:
     *   - modifying the metadata on the finished ticket
     *   - remove finished ticket from the queue it's in
     *   - modifying the metadata on the next ticket in the queue
     */
    var data = [
        {
            bucket: buckets.waitlist_tickets.name,
            key: ticket.uuid,
            value: ticket
        }
    ];

    // if ticket is in serverqueue
    if (ticketIdx !== -1) {
        data.push({
            bucket: buckets.waitlist_queues.name,
            key: self.uuid,
            value: serverqueue,
            options: {
                etag: etag
            }
        });
    }

    queue.splice(ticketIdx, ticketIdx+1);
    serverqueue.tickets[key] = queue;

    Object.keys(serverqueue.tickets).forEach(function (k) {
        if (!serverqueue.tickets[k].length) {
            delete serverqueue.tickets[k];
        }
    });

    var moray = ModelWaitlist.getMoray();

    // We have removed the 'finished' ticket, if there is another ticket in the
    // queue, now we need to mark the "top" ticket as active, and then write
    // back the updated queue.
    vasync.waterfall([
        function (wfcb) {
            if (queue.length) {
                ModelWaitlist.getTicket(queue[0],
                    function (geterror, respticket) {
                        if (geterror) {
                            wfcb(geterror);
                            return;
                        }
                        var nextticket = respticket;

                        nextticket.updated_at = (new Date()).toISOString();
                        nextticket.status = 'active';

                        self.log.info({ ticket: nextticket },
                            'ticket %s is next to be activated',
                            nextticket.uuid);

                        data.push({
                            bucket: buckets.waitlist_tickets.name,
                            key: queue[0],
                            value: nextticket
                        });
                        wfcb();
                    });
                return;
            }
            wfcb();
        },
        function (wfcb) {
            self.log.info({ batch: data },
                          'doing batch write after finishing %s', ticket.uuid);
            moray.batch(data, function (err, meta) {
                if (err) {
                    self.log.warn({ err: err },
                        'batch error after finishing %s', ticket.uuid);
                }

                if (err &&
                   (VError.hasCauseWithName(err, 'EtagConflictError') ||
                   (VError.hasCauseWithName(err, 'UniqueAttributeError'))))
                {
                    process.nextTick(function () {
                        self.ensureServerQueue(function (err2, resp) {
                            if (err2) {
                                self.log.warn(
                                    { err: err2 },
                                    'ensureServerQueue error %s', ticket.uuid);
                                wfcb(err2);
                                return;
                            }
                            self.log.warn(
                                { err: err },
                                'retrying ' +
                                'self.finishTicketUpdateQueueActivateNext %s',
                                ticket.uuid);
                            self.finishTicketUpdateQueueActivateNext(
                                ticket,
                                resp.serverqueue,
                                resp.etag, wfcb);
                        });
                    });
                    return;
                } else {
                    wfcb();
                }
            });
        }
    ],
    function (wferr) {
        self.log.info(
            { err: wferr }, 'error self.finishTicketUpdateQueueActivateNext %s',
            ticket.uuid);
        callback(wferr);
    });
};



ModelWaitlist.prototype.pushTicketUpdateQueue =
function (ticket, serverqueue, etag, callback) {
    var self = this;
    var key = orderedKVString({ id: ticket.id, scope: ticket.scope });

    Object.keys(serverqueue.tickets).forEach(function (k) {
        if (!serverqueue.tickets[k].length) {
            delete serverqueue.tickets[k];
        }
    });

    if (!serverqueue.tickets[key]) {
        serverqueue.tickets[key] = [];
    }

    if (!serverqueue.tickets[key].length) {
        ticket.status = 'active';
    } else {
        ticket.status = 'queued';
    }

    ticket.created_at =
    ticket.updated_at =
    serverqueue.updated_at =
        (new Date()).toISOString();

    serverqueue.tickets[key].push(ticket.uuid);

    var data = [
        {
            bucket: buckets.waitlist_tickets.name,
            key: ticket.uuid,
            value: ticket
        },
        {
            bucket: buckets.waitlist_queues.name,
            key: self.uuid,
            value: serverqueue,
            options: {
                etag: etag
            }
        }
    ];

    var moray = ModelWaitlist.getMoray();
    moray.batch(data, function (err, meta) {
        if (err && (VError.hasCauseWithName(err, 'EtagConflictError') ||
                   (VError.hasCauseWithName(err, 'UniqueAttributeError'))))
        {
            process.nextTick(function () {
                self.ensureServerQueue(function (err2, resp) {
                    if (err2) {
                        callback(err2);
                        return;
                    }

                    self.pushTicketUpdateQueue(
                        ticket,
                        resp.serverqueue,
                        resp.etag, callback);
                });
            });
            return;
        } else {
            callback(null, serverqueue.tickets[key]);
        }
    });
};



ModelWaitlist.prototype.createTicket = function (params, callback) {
    var self = this;

    assert.object(params, 'params');
    assert.string(params.scope, 'params.scope');
    assert.string(params.id, 'params.id');
    assert.string(params.expires_at, 'params.expires_at');

    var ticket_uuid = libuuid.create();

    var serverqueue = null;
    var etag = null;
    var ticket = {
        uuid: ticket_uuid,
        server_uuid: this.uuid,
        scope: params.scope,
        id: params.id,
        expires_at: params.expires_at,
        created_at: (new Date()).toISOString(),
        updated_at: (new Date()).toISOString(),
        status: 'queued',
        action: params.action,
        reqid: params.req_id,
        extra: params.extra || {}
    };
    var queue;

    self.log.info({
        ticket: ticket
    }, 'creating ticket %s', ticket_uuid);

    vasync.waterfall([
        ensureServerQueue,
        writeTicket,
        getQueueTickets
    ],
    function (wferror) {
        callback(wferror, ticket_uuid, queue);
    });

    // Read the value of server queue and make sure it exists before
    // continuing. If it doesn't exist, create it, taking care of dealing with
    // write conflicts.

    function ensureServerQueue(cb) {
        self.ensureServerQueue(function (err, resp) {
            if (err) {
                cb(err);
                return;
            }

            etag = resp.etag;
            serverqueue = resp.serverqueue;

            cb();
        });
    }

    // Write the ticket out and update the queue in a moray transaction
    // (via `batch`). If we get an 'conflict' error, retry starting back at
    // ensureServerQueue.

    function writeTicket(cb) {
        self.pushTicketUpdateQueue(
            ticket, serverqueue, etag,
            function (err, pQueue) {
                queue = pQueue;
                cb(err);
            });
    }

    // Look up any tickets in our scope before ours
    function getQueueTickets(cb) {
        vasync.forEachParallel({
            'func': ModelWaitlist.getTicket,
            'inputs': queue
        }, function (err, pQueue) {
            queue = pQueue.successes.sort(function (a, b) {
                return a.created_at > b.created_at;
            });
            cb();
        });
    }
};



ModelWaitlist.prototype.expireTicket = function (ticket_uuid, callback) {
    // Steps to release a ticket:
    // Batch
    //   - confirm ticket status to see if there is any actual work to be done
    //   - confirm queue status to see if there is any actual work to be done
    //
    // Batch:
    //   - delete ticket
    //   - remove ticket from queue
    //   - update next ticket's status => active if it is first

    var self = this;
    var ticket;
    var serverqueue;
    var etag;
    var wl;

    self.log.info({ uuid: ticket_uuid }, 'going to expire ticket');

    vasync.waterfall([
        function (wfcb) {
            ModelWaitlist.getTicket(ticket_uuid,
                function (geterror, respticket) {
                    if (geterror) {
                        wfcb(new VError(
                            geterror, 'failed to load ticket %s',
                            ticket_uuid));
                        return;
                    }

                    if (!respticket) {
                        wfcb(new VError(
                            'no such ticket %s', ticket_uuid));
                        return;
                    }

                    ticket = respticket;
                    wfcb();
                });
        },
        function (wfcb) {
            ModelWaitlist.log.info(
                { ticket: ticket }, 'the ticket to be expired was');
            wl = new ModelWaitlist({ uuid: ticket.server_uuid });
            wl.getServerQueue(function (err, respserverqueue, res) {
                if (err) {
                    callback(VError(
                        err, 'loading waitlist queue for server %s',
                        ticket.server_uuid));
                    return;
                }

                serverqueue = respserverqueue;
                etag = res.etag;

                wfcb();
            });
        },
        function (wfcb) {
            ticket.status = 'expired';
            ticket.updated_at = (new Date()).toISOString();
            wl.expireTicketUpdateQueueActivateNext(
                ticket, serverqueue, etag, wfcb);
        }
    ],
    function (err) {
        callback(err);
    });
};


ModelWaitlist.deleteTicket =
function (ticket_uuid, callback) {
    // Steps to release a ticket:
    // Batch
    //   - confirm ticket status to see if there is any actual work to be done
    //   - confirm queue status to see if there is any actual work to be done
    //
    // Batch:
    //   - delete ticket
    //   - remove ticket from queue
    //   - update next ticket's status => active if it is first

    var ticket;
    var serverqueue;
    var etag;
    var wl;

    vasync.waterfall([
        function (wfcb) {
            ModelWaitlist.getTicket(ticket_uuid,
                function (geterror, respticket) {
                    if (geterror) {
                        wfcb(new VError(geterror, 'failed to load ticket %s',
                                        ticket_uuid));
                        return;
                    }

                    if (!respticket) {
                        wfcb(new VError('no such ticket %s', ticket_uuid));
                        return;
                    }

                    ticket = respticket;
                    wfcb();
                });
        },
        function (wfcb) {
            ModelWaitlist.log.info(
                { ticket: ticket }, 'the ticket to be deleted was');
            wl = new ModelWaitlist({ uuid: ticket.server_uuid });
            wl.getServerQueue(function (err, respserverqueue, res) {
                if (err) {
                    callback(VError(
                        err, 'loading waitlist queue for server %s',
                        ticket.server_uuid));
                    return;
                }

                serverqueue = respserverqueue;
                etag = res.etag;

                wfcb();
            });
        },
        function (wfcb) {
            ticket.status = 'finished';
            ticket.updated_at = (new Date()).toISOString();
            wl.removeTicketUpdateQueueActivateNext(
                ticket, serverqueue, etag, wfcb);
        }
    ],
    function (err) {
        callback(err);
    });
};


/**
 * Only clears the queue on a `cnapi_waitlist_queues` bucket item.
 */

ModelWaitlist.prototype.emptyServerQueue = function (callback) {
    var self = this;
    var serverqueue = null;
    var moray = ModelWaitlist.getMoray();

    vasync.waterfall([
        function (wfcb) {
            self.getServerQueue(function (err, s, res) {
                if (err) {
                    wfcb(err);
                    return;
                }

                serverqueue = s;
                wfcb();
            });

        },
        function (wfcb) {
            serverqueue = {
                server_uuid: self.uuid,
                updated_at: (new Date()).toISOString(),
                tickets: {}
            };

            moray.putObject(
                buckets.waitlist_queues.name,
                self.uuid,
                serverqueue,
                {},
                function (err, response) {
                    if (err) {
                        wfcb(err);
                        return;
                    }

                    wfcb();
                    return;
                });
        }
    ],
    function (err) {
        callback(err, { serverqueue: serverqueue });
    });
};


ModelWaitlist.prototype.deleteAllTickets = function (callback) {
    var self = this;

    var done = false;

    self.emptyServerQueue(function (err) {
        if (err) {
            callback(err);
            return;
        }
        async.whilst(
            function () { return !done; },
            onIteration, onDone);
    });

    function onIteration(wlcb) {
        vasync.waterfall([
            function (wfcb) {
                ModelWaitlist.getMoray().deleteMany(
                    buckets.waitlist_tickets.name,
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
    ModelWaitlist.getTicket(uuid, function (geterror, ticket) {
        if (geterror) {
            callback(
                VError(geterror, 'failed to retrieve ticket %s', uuid));
            return;
        }

        if (params.status) {
            ticket.status = params.status;
        }

        ticket.updated_at = (new Date()).toISOString();

        ModelWaitlist.getMoray().putObject(
            buckets.waitlist_tickets.name,
            uuid,
            ticket,
            function (puterror) {
                if (puterror) {
                    callback(
                        VError(puterror,
                            'failed to store updated ticket'));
                    return;
                }
                callback();
            });
    });
};



module.exports = ModelWaitlist;
