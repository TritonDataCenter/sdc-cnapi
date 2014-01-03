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
 * - at start-up, find all active tickets (for servers assigned to this CNAPI
 *   instance)
 *
 * - only work on tickets belonging to servers assigned to this CNAPI instance.
 * - on start-up, fetch all tickets
 * - every $period (1s) check for tickets updated since last time we checked
 *
 * Use cases:
 *   - client requests ticket for (server resource; no active tickets);
 *   - client requests ticket for (server resource; active tickets);
 */

WaitlistDirector.prototype.initializeTicketQueue = function () {
    var self = this;
    self.activeTicketsByValues = {};
    self.activeTicketsByUuid = {};
};



WaitlistDirector.prototype.onCheck = function (tickets) {
    var self = this;

    tickets.forEach(function (ticket) {
        var kvkey = common.orderedKVString({
            scope: ticket.scope,
            id: ticket.id,
            server_uuid: ticket.server_uuid
        });

        switch (ticket.status) {
            case 'active':
            case 'queued':
                // create key for this server/scope/id combination
                // create an entry for this ticket

                if (!self.activeTicketsByValues[kvkey]) {
                    self.activeTicketsByValues[kvkey] = {
                        tickets: []
                    };
                }

                if (!self.activeTicketsByUuid[ticket.uuid]) {
                    self.activeTicketsByValues[kvkey].tickets.push(ticket.uuid);

                    self.activeTicketsByUuid[ticket.uuid] = {
                        ticket: ticket,
                        callbacks: []
                    };
                }

                break;

            case 'finished':
                // if ticket already existed, run all callbacks in list
                if (self.activeTicketsByUuid[ticket.uuid]) {
                    var cbs = self.activeTicketsByUuid[ticket.uuid].callbacks;
                    for (var c in cbs) {
                        c();
                    }

                    delete self.activeTicketsByUuid[ticket.uuid];

                    var active = self.activeTicketsByValues[kvkey].tickets;
                    var idx = active.indexOf(ticket.uuid);

                    delete self.activeTicketsByValues[kvkey].tickets[idx];
                }
                break;

            default:
                break;
        }
    });

    // for each of the keys in activeTicketsByValues check if the first in the
    // list has a status of 'active', if not, set the status as active and then
    // update the status in moray.

    var wl;

    if (Object.keys(self.activeTicketsByValues).length) {
        Object.keys(self.activeTicketsByValues).forEach(function (k) {
            // check if there are any tickets waiting to be started
            if (self.activeTicketsByValues[k].tickets.length > 0) {
                var ticketuuid = self.activeTicketsByValues[k].tickets[0];
                if (self.activeTicketsByUuid[ticketuuid].status === 'queued') {
                    self.activeTicketsByUuid[ticketuuid].status = 'active';

                    var serveruuid =
                        self.activeTicketsByUuid[ticketuuid].server_uuid;

                    wl = new ModelWaitlist({ uuid: serveruuid });
                    wl.updateTicket({ status: 'active' }, function (error) {
                        if (error) {
                            self.log.error(
                                { err: error, ticket: ticketuuid }, 
                                'error updating ticket status in moray');
                        }
                    });
                }
            }
        });

        self.log.info({ active_by_uuid: self.activeTicketsbyUuid });
    }
};



WaitlistDirector.prototype.start = function () {
    var self = this;

    var lastCheck;

    if (!WaitlistDirector.interval) {
        clearInterval(WaitlistDirector.interval);
    }

    self.initializeTicketQueue();

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


                if (!tickets || !tickets.length) {
                    self.log.info({ tickets: tickets },
                                  'no tickets updated since',
                                  lastCheck.toISOString());
                                  // No updated tickets need attention
                    return;
                }

                lastCheck = new Date();

                self.log.info({ tickets: tickets },
                              'tickets updated since %s',
                              lastCheck.toISOString());


                self.onCheck(tickets);
            });
    }
};



WaitlistDirector.prototype.waitForTicketByUuid = function (uuid,  callback) {
    var self = this;
    if (!self.activeTicketsByUuid[uuid]) {
        callback(new verror.VError('no such ticket %s', uuid));
        return;
    }

    self.activeTicketsByUuid[uuid].callbacks.push(callback);
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
        filter = sprintf('&(updated_at>=%s)(!(status=finished))',
            common.filterEscape(params.timestamp.toISOString()));
    } else {
        filter = '(uuid=*)';
    }

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

ModelWaitlist.prototype.ticketRelease = function (ticket_uuid, callback) {
    var self = this;

    self.getTicket(ticket_uuid, function (geterror, ticket) {
        if (geterror) {
            callback(verror.VError(
                geterror, 'failed to load ticket %s', ticket_uuid));
            return;
        }

        ticket.updated_at = (new Date()).toISOString();
        ticket.status = 'finished';

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


ModelWaitlist.prototype.getTicket = function (uuid, callback) {
    var self = this;

    ModelWaitlist.getMoray().getObject(
        buckets.waitlist_tickets.name, uuid, onGet);

    function onGet(error, obj) {
        if (error && error.name === 'ObjectNotFoundError') {
            self.log.error('Server %s not found in moray', uuid);
            callback();
            return;
        } else if (error) {
            self.log.error(error, 'Error fetching server from moray');
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
        action: params.action
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
            callback(err);
            return;
        });
};


ModelWaitlist.prototype.updateTicket = function (uuid, params, callback) {
    var self = this;

    self.getTicket(uuid, function (geterror, ticket) {
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
