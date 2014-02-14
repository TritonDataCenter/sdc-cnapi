var ModelBase = require('./base');
var buckets = require('../apis/moray').BUCKETS;
var assert = require('assert-plus');
var libuuid = require('node-uuid');
var common = require('../common');
var verror = require('verror');
var sprintf = require('sprintf').sprintf;

function WaitlistDirector(params) {
    var self = this;
    self.params = params;
    self.log = params.log.child();
}


/**
 * Start polling Moray for waitlist tickets.
 *
 * - at start-up, gather all pending (status is active, queued) tickets (for
 *   servers assigned to this CNAPI instance)
 *
 * - only work on tickets belonging to servers assigned to this CNAPI instance.
 * - on start-up, fetch all tickets
 * - every $period (1s) check for tickets updated since last time we checked
 *
 * Use cases:
 *   - client requests ticket for (server resource; no active tickets);
 *   - client requests ticket for (server resource; active tickets);
 */

WaitlistDirector.prototype.onUpdate = function (timestamp, tickets) {
    var self = this;

    tickets.forEach(function (ticket) {
        var kvkey = common.orderedKVString({
            scope: ticket.scope,
            id: ticket.id,
            server_uuid: ticket.server_uuid
        });

        // Check if ticket has expired. If it has, update the ticket status as
        // 'expired' in moray, remove from pending lists and execute any
        // waiting callbacks.
        if (ticket.status !== 'expired' &&
            timestamp &&
            timestamp.toISOString() >= ticket.expires_at)
        {
            self.ticketExpired(ticket, kvkey);
        }

        // Check if ticket status has changed.
        switch (ticket.status) {
            case 'active':
            case 'queued':
                // create key for this server/scope/id combination
                // create an entry for this ticket

                self.initializeQueues(ticket, kvkey);
                break;

            case 'finished':
                // If ticket existed:
                //   - find ticket in pendingTicketsByValues
                //   - check if there is a subsequent ticket present
                //   - if so, call callbacks present there
                if (self.pendingTicketsByUuid[ticket.uuid]) {
                    self.log.info({
                        ticket_uuid: ticket.uuid
                    }, 'ticket was finished');

                    self.ticketFinished(ticket, kvkey);
                }
                break;

            default:
                break;
        }
    });

    // For each of the keys in pendingTicketsByValues check if the first in the
    // list has a status of 'active', if not, set the status as active and then
    // update the status in moray.

    self.activateNextQueued();
};


WaitlistDirector.prototype.activateNextQueued = function () {
    var self = this;

    var len = Object.keys(self.pendingTicketsByValues).length;

    if (!len) {
        return;
    }

    self.log.info('there were %s active tickets', len);

    Object.keys(self.pendingTicketsByValues).forEach(function (k) {
        // check if there are any tickets waiting to be started

        if (!self.pendingTicketsByValues[k].tickets.length) {
            return;
        }

        var ticketuuid = self.pendingTicketsByValues[k].tickets[0];
        var ticket = self.pendingTicketsByUuid[ticketuuid].ticket;
        self.log.info('top ticket %s', ticketuuid);
        if (ticket.status === 'queued') {
            ticket.status = 'active';

            var serveruuid = ticket.server_uuid;

            self.log.info(
                'updating ticket %s as status => active', ticketuuid);

            var wl = new ModelWaitlist({ uuid: serveruuid });
            wl.updateTicket(
                ticketuuid, { status: 'active' }, function (error) {
                    if (error) {
                        self.log.error(
                            { err: error, ticket: ticketuuid },
                            'error updating ticket status in moray');
                    }
                });
        }
    });
};


WaitlistDirector.prototype.initializeQueues = function (ticket, kvkey) {
    var self = this;

    if (!self.pendingTicketsByValues[kvkey]) {
        self.pendingTicketsByValues[kvkey] = {
            tickets: []
        };
    }

    if (!self.pendingTicketsByUuid[ticket.uuid]) {
        self.pendingTicketsByValues[kvkey].tickets.push(
            ticket.uuid);

        self.pendingTicketsByUuid[ticket.uuid] = {
            ticket: ticket,
            callbacks: []
        };
    }
};

WaitlistDirector.prototype.ticketExpired = function (ticket, kvkey) {
    var self = this;

    var serveruuid = ticket.server_uuid;
    var ticketuuid = ticket.uuid;

    // Update status = 'expired'
    var wl = new ModelWaitlist({ uuid: serveruuid });
    wl.updateTicket(
        ticketuuid, { status: 'expired' }, function (error) {
            if (error) {
                self.log.error(
                    { err: error, ticket: ticketuuid },
                    'error updating ticket status in moray');
            }
        });

    self.log.info(
        'ticket %s has expired (expiry at %s)', ticket.uuid,
        ticket.expires_at);


    if (self.pendingTicketsByUuid[ticket.uuid]) {

        // Run callbacks for next ticket in this kvkey

        var cur = self.pendingTicketsByValues[kvkey]
                    .tickets.indexOf(ticket.uuid);

        var next = self.pendingTicketsByValues[kvkey].tickets[cur+1];

        var cbs;
        var err = new Error('ticket has expired');
        if (self.pendingTicketsByUuid[next]) {
            cbs = self.pendingTicketsByUuid[next].callbacks;
            for (var c in cbs) {
                cbs[c](err);
            }
        }

        delete self.pendingTicketsByUuid[ticket.uuid];

        var active = self.pendingTicketsByValues[kvkey].tickets;
        var idx = active.indexOf(ticket.uuid);

        if (idx !== -1) {
            self.pendingTicketsByValues[kvkey]
                .tickets.splice(idx, idx+1);
        }

        if (active.length === 0) {
            delete self.pendingTicketsByValues[kvkey];
        }
    }

    return;
};


WaitlistDirector.prototype.ticketFinished = function (ticket, kvkey) {
    var self = this;

    var cur = self.pendingTicketsByValues[kvkey].tickets.indexOf(ticket.uuid);

    var next = self.pendingTicketsByValues[kvkey].tickets[cur+1];

    var cbs;
    if (self.pendingTicketsByUuid[next]) {
        cbs = self.pendingTicketsByUuid[next].callbacks;
        for (var c in cbs) {
            cbs[c]();
        }
    }

    delete self.pendingTicketsByUuid[ticket.uuid];

    var active = self.pendingTicketsByValues[kvkey].tickets;
    var idx = active.indexOf(ticket.uuid);

    if (idx !== -1) {
        self.pendingTicketsByValues[kvkey]
            .tickets.splice(idx, idx+1);
    }

    if (active.length === 0) {
        delete self.pendingTicketsByValues[kvkey];
    }
};


WaitlistDirector.prototype.start = function () {
    var self = this;

    var lastCheck;

    self.log.info('periodically checking for waitlist ticket changes');

    if (!WaitlistDirector.interval) {
        clearInterval(WaitlistDirector.interval);
    }

    self.pendingTicketsByValues = {};
    self.pendingTicketsByUuid = {};

    WaitlistDirector.interval = setInterval(intervalFn, 1000);

    function intervalFn() {
        // request all waitlist tickets updated since last time for servers
        // over which we exert control.
        ModelWaitlist.ticketsUpdatedSince(
            { cnapi_uuid: self.uuid,
              timestamp: lastCheck
            },
            function (error, tickets) {
                if (error) {
                    self.log.error(
                        { error: error }, 'failed to get tickets since %s',
                        lastCheck);
                }

                var date = lastCheck;
                lastCheck = new Date();

                self.log.debug({ tickets: tickets },
                              'tickets updated since %s',
                              date ? date.toISOString() : 'start-up');


                if (!tickets || !tickets.length) {
                    // No updated tickets need attention
                    return;
                }

                self.onUpdate(date, tickets);
            });
    }
};



WaitlistDirector.prototype.waitForTicketByUuid = function (uuid,  callback) {
    var self = this;
    if (!self.pendingTicketsByUuid[uuid]) {
        callback(new verror.VError('no such ticket %s', uuid));
        return;
    }

    self.pendingTicketsByUuid[uuid].callbacks.push(callback);
};


function ModelWaitlist(params) {
    assert.object(params, 'params');
    assert.string(params.uuid, 'params.uuid');

    this.uuid = params.uuid; // server uuid
    this.log = ModelWaitlist.getLog();
}

ModelWaitlist.createWaitlistDirector = function (params) {
    return new WaitlistDirector(params);
};

ModelWaitlist.init = function (app) {
    this.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelWaitlist[p] = ModelBase.staticFn[p];
    });

    ModelWaitlist.log = app.getLog();
};


ModelWaitlist.ticketsUpdatedSince = function (params, callback) {
    var self = this;
    var moray = ModelWaitlist.getMoray();
    var filter;

    if (params.timestamp) {
        filter = sprintf(
            '|(updated_at>=%s)' +
             '(&(!(status=expired))(!(expires_at>=%s)))',
            common.filterEscape(params.timestamp.toISOString()),
            common.filterEscape(params.timestamp.toISOString()));
    } else {
        filter = '&(!(status=expired))(!(status=finished))';
    }

    var findOpts = {
        sort: {
            attribute: 'created_at',
            order: 'ASC'
        }
    };

    try {
        var req = moray.findObjects(
            buckets.waitlist_tickets.name, filter, findOpts);
    }
    catch (e) {
        self.log.warn({ error: e }, 'Got an exception from moray');
        callback(null, tickets);
        return;
    }

    var tickets = [];

    if (!req) {
        self.log.warn('Got a null req object from moray');
        callback(null, tickets);
        return;
    }

    req.on('error', onError);
    req.on('record', onRecord);
    req.on('end', processResults);

    function onError(error) {
        self.log.error(error, 'Error retriving results');
        callback(error);
    }

    function onRecord(ticket) {
        tickets.push(ticket.value);
    }

    function processResults() {
        callback(null, tickets);
    }
};

ModelWaitlist.ticketRelease = function (ticket_uuid, callback) {
    var self = this;

    ModelWaitlist.getTicket(ticket_uuid, function (geterror, ticket) {
        if (geterror) {
            callback(verror.VError(
                geterror, 'failed to load ticket %s', ticket_uuid));
            return;
        }

        if (!ticket) {
            callback(
                verror.VError('no such ticket %s', ticket));
        }

        ticket.updated_at = (new Date()).toISOString();
        ticket.status = 'finished';

        self.log.info({ uuid: ticket_uuid }, 'marking ticket as "finished"');
        ModelWaitlist.getMoray().putObject(
            buckets.waitlist_tickets.name,
            ticket_uuid,
            ticket,
            function (putError) {
                if (putError) {
                    var err = verror.VError(
                        putError, 'failed to store default server');
                    callback(err);
                    return;
                }

                callback();
            });
    });
};

ModelWaitlist.list = function (params, callback) {
    var self = this;
    var moray = ModelWaitlist.getMoray();

    var filter = '(server_uuid=*)';
    var findOpts = {
        sort: {
            attribute: 'created_at',
            order: 'ASC'
        }
    };

    var req = moray.findObjects(
        buckets.waitlist_tickets.name, filter, findOpts);

    var tickets = [];

    req.on('error', onError);
    req.on('record', onRecord);
    req.on('end', processResults);

    function onError(error) {
        self.log.error(error, 'Error retriving results');
        callback(error);
    }

    function onRecord(ticket) {
        tickets.push(ticket.value);
    }

    function processResults() {
        callback(null, tickets);
    }
};


ModelWaitlist.getTicket = function (uuid, callback) {
    var self = this;

    ModelWaitlist.getMoray().getObject(
        buckets.waitlist_tickets.name, uuid, onGet);

    function onGet(error, obj) {
        if (error && error.name === 'ObjectNotFoundError') {
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


ModelWaitlist.prototype.createTicket = function (params, callback) {
    var self = this;

    assert.object(params, 'params');
    assert.string(params.scope, 'params.scope');
    assert.string(params.id, 'params.id');
    assert.string(params.expires_at, 'params.expires_at');

    var ticket_uuid = libuuid.v4();

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
        req_id: params.req_id
    };

    ModelWaitlist.getMoray().putObject(
        buckets.waitlist_tickets.name,
        ticket_uuid,
        ticket,
        function (putError) {
            if (putError) {
                var err = verror.VError(
                    putError, 'failed to write ticket to moray');
                self.log.error(
                    { err: err }, 'Could not store ticket');
                callback(err);
                return;
            }

            callback(null, ticket_uuid);
        });
};


ModelWaitlist.prototype.deleteTicket = function (uuid, callback) {
    var self = this;

    assert.string(uuid, 'uuid');

    ModelWaitlist.getMoray().delObject(
        buckets.waitlist_tickets.name,
        uuid,
        function (delError) {
            if (delError) {
                var err = verror.VError(
                    delError, 'failed to delete ticket');
                self.log.error(
                    { err: delError }, 'error deleting ticket');
                callback(err);
                return;
            }

            callback();
        });
};


ModelWaitlist.prototype.deleteAllTickets = function (params, callback) {
    var self = this;

    ModelWaitlist.getMoray().deleteMany(
        buckets.waitlist_tickets.name,
        '(server_uuid=' + self.uuid + ')',
        function (delError) {
            var err = verror.VError(
                delError, 'failed to store default server');
            self.log.error(
                { err: err }, 'Could not store default server');


            ModelWaitlist.app.waitlistDirector.pendingTicketsByValues = {};
            ModelWaitlist.app.waitlistDirector.pendingTicketsByUuid = {};

            callback(err);
            return;
        });
};


ModelWaitlist.prototype.updateTicket = function (uuid, params, callback) {
    ModelWaitlist.getTicket(uuid, function (geterror, ticket) {
        if (geterror) {
            callback(
                verror.VError(geterror, 'failed to retrieve ticket %s', uuid));
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
                        verror.VError(puterror,
                            'failed to store updated ticket'));
                    return;
                }
                callback();
            });
    });
};


module.exports = ModelWaitlist;
