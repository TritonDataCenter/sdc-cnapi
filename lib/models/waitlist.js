var ModelBase = require('./base');
var buckets = require('../apis/moray').BUCKETS;
var assert = require('assert-plus');
var libuuid = require('node-uuid');
var verror = require('verror');
var sprintf = require('sprintf').sprintf;

function ModelWaitlist(params) {
    assert.object(params, 'params');
    assert.string(params.uuid, 'params.uuid');

    this.uuid = params.uuid; // server uuid
    this.log = ModelWaitlist.getLog();
}

ModelWaitlist.init = function (app) {
    this.app = app;

    Object.keys(ModelBase.staticFn).forEach(function (p) {
        ModelWaitlist[p] = ModelBase.staticFn[p];
    });

    ModelWaitlist.log = app.getLog();
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
        status: 'queued'
    };

    ModelWaitlist.getMoray().putObject(
        buckets.waitlist_tickets.name,
        ticket_uuid,
        ticket,
        function (putError) {
            if (putError) {
                var err = verror.VError(
                    putError, 'failed to store default server');
                self.log.error(
                    { err: err }, 'Could not store default server');
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
