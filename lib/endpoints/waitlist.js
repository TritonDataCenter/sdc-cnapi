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
 * @endpoint GET /servers/:server_uuid/waitlist
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

ControllerWaitlist.createTicket = function (req, res, next) {
    var waitlist = req.stash.server.getWaitlist();
    waitlist.createTicket(req.params, function (error, uuid) {
        res.send(202, { uuid: uuid});
        next();
        return;
    });
};

ControllerWaitlist.getTicket = function (req, res, next) {
    var waitlist = req.stash.server.getWaitlist();

    waitlist.getTicket(req.params.ticket_uuid, function (error, ticket) {
        res.send(200, ticket);
        next();
        return;
    });
};

ControllerWaitlist.deleteTicket = function (req, res, next) {
    var waitlist = req.stash.server.getWaitlist();
    var ticket_uuid = req.params.ticket_uuid;

    waitlist.getTicket(ticket_uuid, function (error, ticket) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        if (!ticket) {
            var errorMsg = 'ticket ' + ticket_uuid + ' not found';
            next(new restify.ResourceNotFoundError(errorMsg));
            return;
        }

        waitlist.deleteTickets(function (delError) {
            res.send(204);
            next();
            return;
        });
    });
};

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


ControllerWaitlist.wait = function (req, res, next) {
    var waitlist = req.stash.server.getWaitlist();
    var ticketuuid = req.params.ticket_uuid;

    waitlist.getTicket(ticketuuid, function (error, ticket) {
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

ControllerWaitlist.release = function (req, res, next) {
    var ticket_uuid = req.params.ticket_uuid;
    var waitlist = req.stash.server.getWaitlist();

    waitlist.getTicket(ticket_uuid, function (error, ticket) {
        if (error) {
            next(new restify.InternalError(error.message));
            return;
        }

        if (!ticket) {
            var errorMsg = 'ticket ' + ticket_uuid + ' not found';
            next(new restify.ResourceNotFoundError(errorMsg));
            return;
        }

        waitlist.ticketRelease(ticket_uuid, function (relerror) {
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
        { path: '/servers/:server_uuid/waitlist', name: 'ServerWaitlistList' },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        ControllerWaitlist.list);

    // Get waitlist
    http.get(
        {
            path: '/servers/:server_uuid/waitlist/:ticket_uuid',
            name: 'ServerWaitlistGetTicket'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        ControllerWaitlist.getTicket);

    // Create waitlist ticket
    http.post(
        {
            path: '/servers/:server_uuid/waitlist',
            name: 'ServerWaitlistTicketCreate'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        ControllerWaitlist.createTicket);

    // Delete waitlist ticket
    http.del(
        {
            path: '/servers/:server_uuid/waitlist',
            name: 'ServerWaitlistTicketsAllDelete'
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
            path: '/servers/:server_uuid/waitlist/:ticket_uuid/wait',
            name: 'ServerWaitlistTicketsWait'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        ControllerWaitlist.wait);

    // Update ticket
    http.put(
        {
            path: '/servers/:server_uuid/waitlist/:ticket_uuid/release',
            name: 'ServerWaitlistATicketRelease'
        },
        ensure({
            connectionTimeoutSeconds: 60 * 60,
            app: app,
            prepopulate: ['server'],
            connected: ['moray']
        }),
        ControllerWaitlist.release);
}

exports.attachTo = attachTo;
