/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * HTTP endpoints for interacting with server wait lists.
 * See docs/waitlist.md for more details.
 */

var restify = require('restify');
var once = require('once');
var sprintf = require('sprintf').sprintf;
var url = require('url');
var async = require('async');
var verror = require('verror');

var validation = require('../validation/endpoints');
var ModelServer = require('../models/server');
var ModelVM = require('../models/vm');
var ModelWaitlist = require('../models/waitlist');

function ControllerWaitlist() {}

ControllerWaitlist.init = function () {
    ControllerWaitlist.log = ModelWaitlist.log;
};

/* BEGIN JSSTYLED */
/**
 * Returns all waitlist tickets currently active on a server.
 *
 * @name ServerWaitlistList
 * @endpoint GET /servers/:server_uuid/tickets
 * @section Waitlist
 *
 * @response 200 Array Waitlist returned successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

ControllerWaitlist.list = function (req, res, next) {
    var params = {};

    ModelWaitlist.list(
        params,
        function (error, tickets) {
            if (error) {
                next(new restify.InternalError(error.message));
                return;
            }
            res.send(tickets);
            next();
        });
};


/* BEGIN JSSTYLED */
/**
 * Create a new waitlist ticket.
 *
 * @name ServerWaitlistTicketCreate
 * @endpoint POST /servers/:server_uuid/tickets
 * @section Waitlist
 *
 * @param {String} scope Limit the ticket to the given scope
 * @param {String} id The id of the resource of type 'scope'
 * @param {String} expires_at ISO 8601 date string when ticket will expire
 * @param {String} action Description of acting to be undertaken
 *
 * @response 202 Array Waitlist ticket created successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

ControllerWaitlist.createTicket = function (req, res, next) {
    var waitlist = req.stash.server.getWaitlist();
    waitlist.createTicket(req.params, function (error, uuid) {
        // Delay a couple of seconds to allow the new ticket to be picked by
        // the waitlist director
        setTimeout(function () {
            res.send(202, { uuid: uuid});
            next();
            return;
        }, 2000);
    });
};


/* BEGIN JSSTYLED */
/**
 * Retrieve a waitlist ticket.
 *
 * @name ServerWaitlistGetTicket
 * @endpoint POST /tickets/:ticket_uuid
 * @section Waitlist
 *
 * @response 200 Array Waitlist ticket returned successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

ControllerWaitlist.getTicket = function (req, res, next) {
    ModelWaitlist.getTicket(req.params.ticket_uuid, function (error, ticket) {
        res.send(200, ticket);
        next();
        return;
    });
};


/* BEGIN JSSTYLED */
/**
 * Delete a waitlist ticket.
 *
 * @name ServerWaitlistDeleteTicket
 * @endpoint DELETE /tickets/:ticket_uuid
 * @section Waitlist
 *
 * @response 204 Array Waitlist ticket deleted successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

ControllerWaitlist.deleteTicket = function (req, res, next) {
    var waitlist = req.stash.server.getWaitlist();
    var ticket_uuid = req.params.ticket_uuid;

    ModelWaitlist.getTicket(ticket_uuid, function (error, ticket) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        if (!ticket) {
            var errorMsg = 'ticket ' + ticket_uuid + ' not found';
            next(new restify.ResourceNotFoundError(errorMsg));
            return;
        }

        waitlist.deleteTicket(ticket_uuid, function (delError) {
            res.send(204);
            next();
            return;
        });
    });
};


/* BEGIN JSSTYLED */
/**
 * Delete all of a server's waitlist tickets.
 *
 * @name ServerWaitlistTicketsDeleteAll
 * @endpoint DELETE /servers/:server_uuid/tickets
 * @section Waitlist
 *
 * @param {Boolean} force Must be set to 'true' for delete to succeed
 *
 * @response 204 Array Waitlist ticket deleted successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

ControllerWaitlist.deleteAllTickets = function (req, res, next) {
    var waitlist = req.stash.server.getWaitlist();

    if (req.params.force !== 'true') {
        next(new restify.PreconditionFailedError(
            'Will not delete all tickets without ?force=true'));
        return;
    }

    waitlist.deleteAllTickets(
        {},
        function (error, ticket) {
            res.send(204);
            next();
            return;
        });
};


/* BEGIN JSSTYLED */
/**
 * Wait until a waitlist ticket either expires or becomes active.
 *
 * @name ServerWaitlistTicketsWait
 * @endpoint GET /tickets/:ticket_uuid/wait
 * @section Waitlist
 *
 * @response 204 Array Ticket active or expired
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

ControllerWaitlist.wait = function (req, res, next) {
    var ticketuuid = req.params.ticket_uuid;

    ModelWaitlist.getTicket(ticketuuid, function (error, ticket) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        if (!ticket) {
            next(new restify.ResourceNotFoundError(
                'No such ticket %s', req.params.ticket_uuid));
            return;
        }

        if (ticket.status === 'finished') {
            res.send(204);
            next();
            return;
        }

        var cb = function (waiterror) {
            if (waiterror) {
                next(new restify.InternalError(waiterror.message));
                return;
            }

            res.send(204);
            next();
            return;
        };

        req.stash.app.waitlistDirector.waitForTicketByUuid(ticketuuid, cb);
    });
};


/* BEGIN JSSTYLED */
/**
 * Release a currently active or queued waitlist ticket.
 *
 * @name ServerWaitlistTicketsWait
 * @endpoint GET /tickets/:ticket_uuid/release
 * @section Waitlist
 *
 * @response 204 Array Ticket released successfully
 * @response 500 Error Could not process request
 */
/* END JSSTYLED */

ControllerWaitlist.release = function (req, res, next) {
    var ticket_uuid = req.params.ticket_uuid;

    ModelWaitlist.getTicket(ticket_uuid, function (error, ticket) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        if (!ticket) {
            var errorMsg = 'ticket ' + ticket_uuid + ' not found';
            next(new restify.ResourceNotFoundError(errorMsg));
            return;
        }

        ModelWaitlist.ticketRelease(ticket_uuid, function (relerror) {
            if (relerror) {
                next(new restify.InternalError(relerror.message));
                return;
            }

            res.send(204);
            next();
        });
    });
};


function attachTo(http, app) {
    ControllerWaitlist.init();

    var ensure = require('../endpoints').ensure;

    // List waitlist
    http.get(
        { path: '/servers/:server_uuid/tickets', name: 'ServerWaitlistList' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        ControllerWaitlist.list);

    // Get waitlist ticket
    http.get(
        {
            path: '/tickets/:ticket_uuid',
            name: 'ServerWaitlistGetTicket'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: [],
            connected: ['moray']
        }),
        ControllerWaitlist.getTicket);

    // Create waitlist ticket
    http.post(
        {
            path: '/servers/:server_uuid/tickets',
            name: 'ServerWaitlistTicketCreate'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        ControllerWaitlist.createTicket);

    // Delete all waitlist ticket
    http.del(
        {
            path: '/servers/:server_uuid/tickets',
            name: 'ServerWaitlistTicketsDeleteAll'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        ControllerWaitlist.deleteAllTickets);


    // Wait on ticket to be ready to be serviced
    http.get(
        {
            path: '/tickets/:ticket_uuid/wait',
            name: 'ServerWaitlistTicketsWait'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: [],
            connected: ['moray']
        }),
        ControllerWaitlist.wait);

    // Wait on ticket to be ready to be serviced
    http.del(
        {
            path: '/tickets/:ticket_uuid',
            name: 'ServerWaitlistDeleteTickets'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: [],
            connected: ['moray']
        }),
        ControllerWaitlist.deleteTicket);


    // Update ticket
    http.put(
        {
            path: '/tickets/:ticket_uuid/release',
            name: 'ServerWaitlistATicketRelease'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: [],
            connected: ['moray']
        }),
        ControllerWaitlist.release);
}

exports.attachTo = attachTo;