/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * This is where the core of CNAPI abstractions and logic is defined:
 */


var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var deepEqual = require('deep-equal');
var execFile = require('child_process').execFile;
var fs = require('fs');
var http = require('http');
var https = require('https');
var verror = require('verror');
var Logger = require('bunyan');
var restify = require('restify');
var sdcClients = require('sdc-clients');
var sprintf = require('sprintf').sprintf;
var TaskClient = require('task_agent/lib/client');
var util = require('util');
var once = require('once');

var amqp = require('./amqp-plus');
var common = require('./common');
var createServer = require('./server').createServer;
var Heartbeater = require('./heartbeater');
var ModelBase = require('./models/base');
var ModelImage = require('./models/image');
var ModelPlatform = require('./models/platform');
var ModelWaitlist = require('./models/waitlist');
var ModelServer = require('./models/server');
var ModelVM = require('./models/vm');
var Moray = require('./apis/moray');
var Ur = require('./ur');
var Workflow = require('./apis/workflow');



var HEARTBEATER_PERIOD = 10;
var SYSINFO_PERIOD = 60;



function App(config) {
    var self = this;

    self.config = config;

    self.log = new Logger({
        name: 'cnapi',
        level: config.logLevel,
        serializers: {
            err: Logger.stdSerializers.err,
            req: Logger.stdSerializers.req,
            res: Logger.stdSerializers.res
        }
    });

    self.serversNeedSysinfo = {};

    self.log.info({ config: config }, 'cnapi config');
    self.config.log = self.log;
    self.collectedGlobalSysinfo = false;

    ModelBase.init(self);
    ModelImage.init(self);
    ModelPlatform.init(self);
    ModelServer.init(self);
    ModelWaitlist.init(self);
    ModelVM.init(self);

    self.statusTimeouts = {};
}



/**
 *
 * CNAPI Start-up sequence:
 *
 * # Initiate HTTP Interface
 *
 * This will allow CNAPI to begin responding to requests immediately, even if
 * they are 500's.
 *
 * # Make connections
 *
 * Connection phase: open connection to all upstream services we depend on.
 * - connect to Workflow API
 * - connect to Moray
 * - connect to AMQP
 *
 * # Setup resources
 *
 * Setup phase: Set up resources needed for normal operation
 * - create queues
 * - setup workflows
 * - broadcast request for information from all servers
 *
 * Once connected to all of the above we may:
 * - Begin listening for heartbeats
 * - Request sysinfo for compute nodes via Ur
 */

App.prototype.start = function () {
    var self = this;

    self.start_timestamp = (new Date()).toISOString();

    async.waterfall([
        function (wfcb) {
            execFile('/usr/bin/zonename', [],
                function (error, stdout, stderr) {
                    if (error) {
                        wfcb(error);
                        return;
                    }
                    self.uuid = stdout.toString();
                    wfcb();
                });
        },
        function (wfcb) {
            self.initializeHttpInterface(wfcb);
        },
        function (wfcb) {
            self.initializeConnections(wfcb);
        }
    ],
    function (error) {
        if (error) {
            self.log.error({ error: error },
                'Error during CNAPI start-up sequence');
            return;
        }
        self.log.info('Reached end of CNAPI start up sequence');
    });
};



App.prototype.startSysinfoChecker = function () {
    var self = this;

    setInterval(function () {
        var uuid;
        for (uuid in self.serversNeedSysinfo) {
            updateSysinfo(uuid);
        }
        self.serversNeedSysinfo = {};
    }, 60000);

    function updateSysinfo(uuid) {
        ModelServer.getUr().serverSysinfo(
            uuid,
            { timeoutSeconds: 10 },
            function (sysinfoerror, sysinfo) {
                if (sysinfoerror) {
                    self.log.error({ err: sysinfoerror },
                        'error fetching sysinfo');
                    return;
                }

                self.log.info({ sysinfo: sysinfo }, 'received sysinfo');

                self.refreshServerFromSysinfo(sysinfo, function (error) {
                    if (error) {
                        self.log.error({ err: error },
                            'refreshing server sysinfo');
                        return;
                    }
                    self.log.info('Successfully modified sysinfo in moray');
                });
        });
    }
};

/**
 * Mark a server as needing to have sysinfo looked up
 */

App.prototype.needSysinfoFromServer = function (uuid) {
    var self = this;
    self.serversNeedSysinfo[uuid] = true;
};

/**
 * This will start our HTTP service and allow us to respond to HTTP requests.
 */

App.prototype.initializeHttpInterface = function (callback) {
    var self = this;

    http.globalAgent.maxSockets = self.config.maxHttpSockets || 100;
    https.globalAgent.maxSockets = self.config.maxHttpSockets || 100;

    self.log.info('Initializing HTTP interface');

    self.server = createServer({
        app: self,
        log: self.log
    });

    self.server.listen(self.config.api.port, function () {
        self.log.info(
            '%s listening at %s',
            self.server.name,
            self.server.url);
    });
    return callback();
};


App.prototype.initializeConnections = function (callback) {
    var self = this;

    self.setupMorayClient();
    self.setupWorkflowClient();
    self.setupWaitlistDirector();

    self.setupAmqpClient();
    self.startSysinfoChecker();

    callback();
};


App.prototype.setupWaitlistDirector = function () {
    var self = this;

    var wldOpts = {
        cnapiUuid: self.uuid,
        log: self.log
    };

    self.waitlistDirector = new ModelWaitlist.createWaitlistDirector(wldOpts);
    async.until(function () {
        return self.moray.connected;
    },
    function (cb) {
        setTimeout(cb, 1000);
    },
    function () {
        self.log.info('Starting waitlist director');
        self.waitlistDirector.start();
    });
};


App.prototype.setupAmqpClient = function () {
    var self = this;
    var connection = self.amqpConnection
        = amqp.createConnection(self.config.amqp, { log: self.log });

    var sub = once(function () {
        self.heartbeater.on(
            'heartbeat',
            function (heartbeat, routingKey) {
                var uuid = routingKey.split('.')[1];
                heartbeat.transport = 'amqp';
                self.onAmqpHeartbeat(uuid, heartbeat);
            });
    });

    connection.on('ready', function () {
        self.log.info('AMQP connection ready');

        self.moray.ensureClientReady(function () {
            self.heartbeater.connection = self.amqpConnection;
            self.heartbeater.bindQueues();
            sub();

            self.ur.useConnection(self.amqpConnection);
            self.ur.bindQueues();

            self.collectGlobalSysinfo(function () {
                self.collectedGlobalSysinfo = true;
            });
        });
    });

    // Set up Ur client.
    self.log.debug('Ready to communicate with ur');
    self.ur = new Ur({ log: self.log });
    self.ur.on('serverStartup', self.onServerStartup.bind(self));
    self.ur.on('serverSysinfo', self.onServerSysinfo.bind(self));

    // Set up provisioner task client.
    this.taskClient = new TaskClient(self.config);
    this.taskClient.useConnection(connection);

    // Set up the heartbeat listener.
    self.heartbeater = new Heartbeater({ log: self.log });
};


App.prototype.setupWorkflowClient = function () {
    var self = this;
    var config = {
        workflows: [
            'server-setup',
            'server-factory-reset',
            'server-sysinfo',
            'server-reboot',
            'server-update-nics'
        ],
        url: self.config.wfapi.url,
        log: this.log,
        path: __dirname + '/workflows',

        forceReplace: true
    };

    this.workflow = new Workflow({
        config: config,
        log: this.log
    });

    this.workflow.startAvailabilityWatcher();

    // Don't proceed with initializing workflows until we have connected.
    function init() {
        async.until(
            function () { return self.workflow.connected; },
            function (cb) {
                setTimeout(cb, 1000);
            },
            function () {
                self.workflow.getClient().initWorkflows(function (error) {
                    if (error) {
                        self.log.error(error, 'Error initializing workflows');
                        init();
                    }
                    self.log.info('Initialized workflows');
                });
            });
    }

    init();
};


App.prototype.setupMorayClient = function () {
    this.moray = new Moray({
        log: this.log,
        config: this.config
    });
    this.moray.connect();
};


/**
 * LEGACY AMQP HEARTBEAT HANDLER
 * Execute this function whenever a heartbeat is received from a server.
 */

App.prototype.onAmqpHeartbeat = function (uuid, heartbeat, callback) {
    var self = this;

    if (!callback) {
        callback = function () {};
    }

    if (! heartbeat.vms) {
        heartbeat.vms = [];
    }

    self.log.trace('Heartbeat (%s) received -- %d zones.',
        uuid, Object.keys(heartbeat.vms).length);

    if (!self.moray.connected) {
        self.log.warn(
            'cannot refresh server from heartbeat: cannot reach moray');
        return;
    }

    ModelServer.get(uuid, function (err, server, serverobj) {
        if (err) {
            self.log.error({ err: err, uuid: uuid },
              'could not look up server in moray');
            return;
        }

        if ((!serverobj || !serverobj.sysinfo) &&
            !self.collectedGlobalSysinfo)
        {
            callback();
            return;
        }

        if (self.statusTimeouts[uuid]) {
            clearTimeout(self.statusTimeouts[uuid]);
        }

        self.statusTimeouts[uuid] = setTimeout(function () {
            self.statusTimeouts[uuid] = null;
            ModelServer.get(uuid, function (e, s, so) {
                if (e) {
                    self.log.error(e,
                        'error trying to get server to update heartbeat');
                    return;
                }
                if (!so.last_heartbeat) {
                        self.log.info(
                            { uuid: uuid },
                            'server had no last_heartbeat property');
                    return;
                }
                var now = Date.now();
                var then = new Date(so.last_heartbeat);
                var timeout = 10;

                if (now - then > timeout*1000) {
                    var payload = { transport: 'amqp', status: 'unknown' };
                    s.modify(payload, function () {
                        self.log.warn(
                            { uuid: uuid },
                            'server no heartbeat from server in %d ' +
                            'seconds, status => unknown',
                            HEARTBEATER_PERIOD);
                    });
                } else {
                    // It we got here it me means we didn't receive a heartbeat
                    // from that server before our timeout, but when we checked
                    // the server the last_heartbeat timestamp appears to have
                    // been updated by another cnapi instance. Everything is
                    // okay.
                    self.log.info(
                        { uuid: uuid },
                        'no heartbeat from server but last_heartbeat looks ok');
                }

            });
        }, HEARTBEATER_PERIOD * 1000);

        server.updateFromVmsUpdate(
            heartbeat,
            function (updateError) {
                if (updateError) {
                    self.log.error(
                        new verror.VError(
                        updateError,
                        'updating server record with heartbeat'));
                    return;
                }

                callback();
            });
    });
};

App.prototype.onVmsUpdate = function (uuid, heartbeat, callback) {
    var self = this;

    self.log.info('vms update');
    if (!callback) {
        callback = function () {};
    }

    if (! heartbeat.vms) {
        heartbeat.vms = [];
    }

    self.log.trace('Heartbeat (%s) received -- %d zones.',
        uuid, Object.keys(heartbeat.vms).length);

    if (!self.moray.connected) {
        self.log.warn(
            'cannot refresh server from heartbeat: cannot reach moray');
        return;
    }

    ModelServer.get(uuid, function (err, server, serverobj) {
        if (err) {
            self.log.error({ err: err, uuid: uuid },
              'could not look up server in moray');
            return;
        }

        if ((!serverobj || !serverobj.sysinfo) &&
            !self.collectedGlobalSysinfo)
        {
            callback();
            return;
        }

        heartbeat.transport = 'http';

        server.updateFromVmsUpdate(
            heartbeat,
            function (updateError) {
                if (updateError) {
                    self.log.error(
                        new verror.VError(
                        updateError,
                        'updating server record with heartbeat'));
                    return;
                }

                callback();
            });
    });
};

App.prototype.onHeartbeat = function (uuid, callback) {
    var self = this;

    self.log.info('heartbeat');
    if (!callback) {
        callback = function () {};
    }

    self.log.trace({ heartbeat: { server_uuid: uuid } },
                   'heartbeat received');

    if (!self.moray.connected) {
        self.log.warn(
            'cannot refresh server from heartbeat: cannot reach moray');
        return;
    }

    ModelServer.get(uuid, function (err, server, serverobj) {
        if (err) {
            self.log.error({ err: err, uuid: uuid },
              'could not look up server in moray');
            return;
        }

        if ((!serverobj || !serverobj.sysinfo) &&
            !self.collectedGlobalSysinfo)
        {
            callback();
            return;
        }

        if (self.statusTimeouts[uuid]) {
            clearTimeout(self.statusTimeouts[uuid]);
        }

        self.statusTimeouts[uuid] = setTimeout(
            onTimeout, HEARTBEATER_PERIOD * 1000);

        ModelServer.get(uuid, function (e, s, so) {
            if (e) {
                self.log.error(
                    'cannot refresh server from heartbeat: cannot reach moray');
                callback();
                return;
            }

            s.modify({ last_heartbeat: (new Date()).toISOString() },
              function (ee) {
                if (ee) {
                    self.log.warn(ee,
                        'could not update server in moray');
                }
            });
        });

        callback();

        function onTimeout() {
            self.statusTimeouts[uuid] = null;
            ModelServer.get(uuid, function (e, s, so) {
                if (!so.last_heartbeat) {
                        self.log.info(
                            { uuid: uuid },
                            'server had no last_heartbeat property');
                    return;
                }
                var now = Date.now();
                var then = new Date(so.last_heartbeat);
                var timeout = 10;

                if (now - then > timeout * 1000) {
                    s.modify({ status: 'unknown' }, function () {
                        self.log.warn(
                            { uuid: uuid },
                            'server no heartbeat from server in %d ' +
                            'seconds, status => unknown', HEARTBEATER_PERIOD);
                    });
                } else {
                    // It we got here it me means we didn't receive a heartbeat
                    // from that server before our timeout, but when we checked
                    // the server the last_heartbeat timestamp appears to have
                    // been updated by another cnapi instance. Everything is
                    // okay.
                    self.log.info(
                        { uuid: uuid },
                        'no heartbeat from server but last_heartbeat looks ok');
                }
            });
        }
    });
};


App.prototype.haveSysinfoNicsChanged = function (sysinfo, fullNapiList) {
    var self = this;

    self.log.trace(
        { nics: fullNapiList }, 'full napi list');

    var existingNics = [];
    var macs = [];
    var i, n;
    var napiNics = {};
    var nics = [];
    var nicsByMAC = {};
    var sysinfoNics = {};
    var toAddNics = [];
    var toUpdateNics = [];
    var uuid = sysinfo['UUID'];

    for (n in sysinfo['Network Interfaces']) {
        sysinfoNics[n] = sysinfo['Network Interfaces'][n];
        macs.push(sysinfo['Network Interfaces'][n]['MAC Address']);
    }
    for (n in sysinfo['Virtual Network Interfaces']) {
        sysinfoNics[n] = sysinfo['Virtual Network Interfaces'][n];
        macs.push(sysinfo['Virtual Network Interfaces'][n]['MAC Address']);
    }

    for (n in fullNapiList) {
        // Equivalent of getNics(sysinfo['UUID'])
        if (fullNapiList[n].belongs_to_uuid === sysinfo['UUID']) {
            nics.push(fullNapiList[n]);
        }

        // Used to get existing nics
        nicsByMAC[fullNapiList[n].mac] = fullNapiList[n];
    }

    // Determine the existing nics
    for (i = 0; i < macs.length; i++) {
        var mac = macs[i];
        var nic = nicsByMAC[mac];

        if (nic) {
            existingNics.push(nic);
        }
    }

    self.log.trace(
        { nics: nics }, 'filtered nics');

    // Now that we have the current nics, go through and figure out
    // if they're adds, deletes, updates, or no change.
    for (n in nics) {
        napiNics[nics[n].mac] = nics[n];
    }
    for (n in existingNics) {
        napiNics[existingNics[n].mac]
        = existingNics[n];
    }

    self.log.trace(
        { napiNics: napiNics }, 'NAPI nics');

    for (n in sysinfoNics) {
        var sysinfoNic = sysinfoNics[n];
        var napiNic = napiNics[sysinfoNic['MAC Address']];
        var newNic = {};

        self.log.trace(
            { sysinfoNic: sysinfoNic, napiNic: napiNic },
            'Checking nic for changes: ' + sysinfoNic['MAC Address']);

        if (!napiNic) {
            newNic = {
                mac: sysinfoNic['MAC Address'],
                belongs_to_uuid: uuid,
                belongs_to_type: 'server',
                owner_uuid: ModelServer.getConfig().adminUuid
            };

            if (sysinfoNic.ip4addr) {
                newNic.ip = sysinfoNic.ip4addr;
            }

            if (sysinfoNic.hasOwnProperty('NIC Names')) {
                newNic.nic_tags_provided = sysinfoNic['NIC Names'];
            }

            if (!sysinfoNic.hasOwnProperty('VLAN') && sysinfoNic.ip4addr) {
                newNic.nic_tag = 'admin';
                newNic.vlan_id = 0;
            }

            if (sysinfoNic.hasOwnProperty('VLAN')) {
                newNic.nic_tag = n.replace(/\d+/, '');
                newNic.vlan_id = Number(sysinfoNic['VLAN']);
            }

            toAddNics.push(newNic);
            continue;
        }

        if (sysinfoNic.ip4addr && (napiNic.ip != sysinfoNic.ip4addr)) {
            newNic.ip = sysinfoNic.ip4addr;
        }

        if (napiNic.belongs_to_uuid != uuid) {
            newNic.belongs_to_uuid = uuid;
        }

        if (napiNic.belongs_to_type != 'server') {
            newNic.belongs_to_type = 'server';
        }

        function listEqual(a, b) {
            if (!a && !b) {
                return true;
            }

            if (!a || !b || (a.length != b.length)) {
                return false;
            }

            a.sort();
            b.sort();

            for (i = 0; i < a.length; i++) {
                if (a[i] != b[i]) {
                    return false;
                }
            }

            return true;
        }

        var equal =
            listEqual(sysinfoNic['NIC Names'],
                      napiNic.hasOwnProperty('nic_tags_provided')
                      ? napiNic.nic_tags_provided : []);



        if (sysinfoNic.hasOwnProperty('NIC Names') && !equal) {
            newNic.nic_tags_provided = sysinfoNic['NIC Names'];
        }

        if (Object.keys(newNic).length !== 0) {
            newNic.mac = sysinfoNic['MAC Address'];
            toUpdateNics.push(newNic);
        }

        delete napiNics[sysinfoNic['MAC Address']];
    }

    var updateNics = toUpdateNics;
    var addNics = toAddNics;
    var deleteNics =
        Object.keys(napiNics).map(function (x) { return napiNics[x]; });
    var changed = updateNics.length || addNics.length || deleteNics.length;

    if (changed) {
        self.log.info({
            updateNics: updateNics,
            addNics: addNics,
            deleteNics: deleteNics,
            napiNics: nics,
            changed: changed
        },
        'Server %s had NIC changes; will execute sysinfo workflow',
        sysinfo['UUID']);

        return true;
    }
    return false;
};


App.prototype.collectGlobalSysinfo = function (callback) {
    var self = this;

    var napi = new sdcClients.NAPI({
        url: self.config.napi.url,
        connectTimeout: 5
    });

    var nics;

    listNics();

    function listNics(waitSecs) {
        self.log.info('Fetching NIC list from NAPI');
        waitSecs = waitSecs || 1;

        napi.listNics({ belongs_to_type: 'server' }, function (error, list) {
            if (error) {
                self.log.warn(error, 'Error fetching server NICs from NAPI');

                setTimeout(function () {
                    listNics(waitSecs * 2);
                }, waitSecs * 1000);
                return;
            }

            nics = list;

            requestSysinfo();
        });
    }

    function requestSysinfo() {
        self.log.info('Broadcasting request for server sysinfo');
        self.ur.broadcastSysinfo(function (error, sysinfoCollection) {
            if (error) {
                self.log.error(error, 'Error broadcasting sysinfo request');
                return;
            }

            async.forEach(
                sysinfoCollection,
                function (sysinfo, cb) {
                    if (self.haveSysinfoNicsChanged(sysinfo, nics)) {
                        self.log.warn('nics for %s have changed',
                                      sysinfo.UUID);
                        ModelServer.beginSysinfoWorkflow(sysinfo);
                    }

                    self.refreshServerFromSysinfo(sysinfo, cb);
                },
                function (err) {
                    if (err) {
                        self.log.error(
                            'Error updating server record from global'
                            + ' broadcast: %s',
                            err.message);
                    }

                    callback();
                });
        });
    }
};


/**
 * Given a sysinfo object, this function will check if the server exists in
 * Moray. Because the sysinfo message is sent only on start-up, if the server
 * does exist in Moray, we will update the record with the most recent
 * information.
 * If the server does not exist, it will be created in Moray.
 */

App.prototype.refreshServerFromSysinfo =
function (sysinfo, refreshcb) {
    var self = this;

    if (!refreshcb) {
        refreshcb = function () {};
    }

    if (!self.moray.connected) {
        self.log.warn(
            'Cannot refresh server from sysinfo: cannot reach moray');
        refreshcb();
        return;
    }

    var uuid = sysinfo['UUID'];

    var sysinfoCarryOverParams = [
        'Zpool', 'Zpool Creation', 'Zpool Disks',
        'Zpool Profile', 'Zpool Size in GiB'];

    var lastboot, created;

    if (sysinfo['Boot Time']) {
        lastboot = new Date(Number(
            sysinfo['Boot Time']) * 1000).toISOString();
    }

    if (sysinfo['Zpool Creation']) {
        created = new Date(Number(
            sysinfo['Zpool Creation']) * 1000).toISOString();
    }

    var shouldInspectServer = false;

    var server, serverModel;

    async.waterfall([
        function (cb) {
            ModelServer.get(uuid, function (err, s, so) {
                if (err) {
                    self.log.error(
                        err, 'Error fetching server %s from Moray', uuid);
                    cb(err);
                    return;
                }

                serverModel = s;
                server = so;
                cb();
            });
        },
        function (cb) {
            if (server) {
                onServerExists(cb);
            } else {
                onServerDoesNotExist(cb);
            }
        }
    ],
    function (error) {
        self.log.debug('Finished processing server (%s) sysinfo', uuid);
        refreshcb();
    });


    function onServerExists(callback) {
        // These parameters, if they exist in the currently stored sysinfo must
        // be copied from the current sysinfo into the new one.
        for (var keyIdx in sysinfoCarryOverParams) {
            var key = sysinfoCarryOverParams[keyIdx];

            if (server.hasOwnProperty('sysinfo') &&
                    server.sysinfo.hasOwnProperty(key))
            {
                sysinfo[key] = server.sysinfo[key];
            }
        }

        ModelServer.updateServerPropertiesFromSysinfo({
            sysinfo: sysinfo,
            server: server
        });

        if (lastboot) {
            server.last_boot = lastboot;
        }

        if (created) {
            server.created = created;
        }

        server.current_platform = sysinfo['Live Image'];
        server.hostname = sysinfo['Hostname'];
        server.transitional_status = '';

        self.log.debug({sysinfo: sysinfo}, 'Server %s existed in moray', uuid);

        async.waterfall([
            function (cb) {
                if (!server.setup && !sysinfo.hasOwnProperty('Setup')) {
                    shouldInspectServer = true;
                }

                if (!server.sysinfo ||
                    !server.sysinfo.hasOwnProperty('Zpool') ||
                    !sysinfo.hasOwnProperty('Zpool') ||
                    !sysinfo.hasOwnProperty('Zpool Creation'))
                {
                    shouldInspectServer = true;
                }

                cb();
            },
            function (cb) {
                if (shouldInspectServer) {
                    inspectServer(function (error, values) {
                        if (error) {
                            self.log.error(error);
                        }

                        lastboot = (
                            new Date(values.boot_time * 1000))
                            .toISOString();

                        created = (
                            new Date(values.zpool_creation * 1000))
                            .toISOString();

                        var setup = server.setup ||
                            (server.sysinfo['Setup'] == 'true' ? true : false);

                        if (values.zpool) {
                            server.sysinfo['Zpool'] = values.zpool;
                            server.sysinfo['Zpool Disks'] = values.zpool_disks;
                            server.sysinfo['Zpool Creation']
                                = values.zpool_creation;
                            server.sysinfo['Zpool Profile']
                                = values.zpool_profile;
                            server.sysinfo['Zpool Size in GiB']
                                = values.zpool_size;
                            setup = true;
                        }

                        server.setup = setup;

                        cb();
                    });
                } else if (sysinfo.hasOwnProperty('Setup')) {
                    self.log.debug('Server %s has \'Setup\' sysinfo'
                            + ' property, set to \'%s\'', sysinfo['UUID'],
                            sysinfo['Setup']);
                    if (sysinfo['Setup'] === false ||
                            sysinfo['Setup'] === 'false')
                    {
                        server.setup = false;
                    } else if (sysinfo['Setup'] === true ||
                            sysinfo['Setup'] === 'true')
                    {
                        server.setup = true;
                    }
                    cb();
                } else {
                    cb();
                }
            }
        ],
        function (error) {
            modify(callback);
        });
    }

    function onServerDoesNotExist(callback) {
        if (!sysinfo['Setup']) {
            self.log.info('New server %s missing sysinfo.Setup', uuid);
            shouldInspectServer = true;
        }

        if (!sysinfo['Zpool']) {
            self.log.info('New server %s missing sysinfo.Zpool', uuid);
            shouldInspectServer = true;
        }

        if (!sysinfo['Zpool Creation']) {
            self.log.info(
                'New server %s missing sysinfo["Zpool Creation"]', uuid);
            shouldInspectServer = true;
        }

        if (shouldInspectServer) {
            inspectServer(function (error, values) {
                if (error) {
                    self.log.error(error);
                }
                lastboot = (
                    new Date(values.boot_time * 1000))
                    .toISOString();

                created = (
                    new Date(values.zpool_creation * 1000))
                    .toISOString();

                if (values.zpool) {
                    create({ setup: true, inspect: values }, callback);
                } else {
                    create({ setup: false, inspect: values }, callback);
                }
            });
        } else {
            var setup = false;
            if (sysinfo['Boot Parameters']['headnode'] === 'true' ||
                sysinfo['Setup'] === true ||
                sysinfo['Setup'] === 'true')
            {
                setup = true;
            } else if (sysinfo['Setup'] === false ||
                sysinfo['Setup'] === 'false')
            {
                setup = false;
            }
            create({ setup: setup }, callback);
            return;
        }
    }


    function inspectServer(cb) {
        self.log.info(
            'Looking up zpools, boot_time on server (%s) via Ur', uuid);

        fs.readFile(
            __dirname + '/../share/inspect-server.sh',
        function (readerror, script) {
            if (readerror) {
                cb(readerror);
                return;
            }

            serverModel.invokeUrScript(
                script.toString(),
                { uuid: uuid },
                function (error, stdout, stderr) {
                    if (error) {
                        self.log.error(
                            'Error fetching list of pools from server %s:' +
                            ' %s', uuid, stderr);
                        cb(error);
                        return;
                    }
                    var values;
                    try {
                        values = JSON.parse(stdout.toString());
                    } catch (e) {
                        cb(new Error(
                            'Error: parsing inspect payload from server'));
                        return;
                    }

                    cb(null, values);
                });
        });
    }


    function create(opts, callback) {
        ModelServer.getBootParamsDefault(
            function (error, params) {
                if (opts.inspect) {
                    // These parameters, if they exist in the currently stored
                    // sysinfo must be copied from the current sysinfo into the
                    // new one.

                    if (opts.inspect.zpool) {
                        sysinfo['Zpool'] = opts.inspect.zpool;
                        sysinfo['Zpool Disks'] = opts.inspect.zpool_disks;
                        sysinfo['Zpool Profile']
                            = opts.inspect.zpool_profile;
                        sysinfo['Zpool Size in GiB']
                            = opts.inspect.zpool_size;
                        opts.setup = true;
                    }
                }
                serverModel.create(
                    {
                        boot_params: params,
                        setup: opts.setup,
                        sysinfo: sysinfo,
                        last_boot: lastboot,
                        created: created,
                        status: 'running'
                    },
                    function (err, s) {
                        if (err) {
                            self.log.error(err,
                                'Error getting default parameters');
                            callback(err);
                            return;
                        }
                        callback();
                    });
            });
    }


    function modify(cb) {
        if (lastboot) {
            server.last_boot = lastboot;
        }
        if (created) {
            server.created = created;
        }
        server.status = 'running';
        serverModel.modify(
            server,
            function (modifyError) {
                if (modifyError) {
                    self.log.error(
                        modifyError,
                        serverModel.errorFmt(
                            'modifying server record'),
                        uuid);
                    return;
                }
                self.log.debug('Modified server record');
                cb();
                return;
            });
    }
};


/**
 * Execute this function whenver a sysinfo message is received via AMQP from
 * the Ur agent of a server which has started up.
 */

App.prototype.onServerStartup = function (message, routingKey) {
    var self = this;

    var uuid = routingKey.split('.')[2];
    self.log.info('Startup sysinfo message received from %s', uuid);
    self.log.trace(message);

    if (self.workflow.connected) {
        ModelServer.beginSysinfoWorkflow(message);
    } else {
        self.log.info({ uuid: uuid},
            'Could not create sysinfo workflow: workflow unavailable');
    }
    ModelServer.get(uuid, function (err, servermodel, server) {
        if (err) {
            self.log.error(err, 'Error listing servers');
            return;
        }

        if (!server.setup && !self.statusTimeouts[uuid]) {
            clearTimeout(self.statusTimeouts[uuid]);

            self.statusTimeouts[uuid] = setTimeout(function () {
                self.statusTimeouts[uuid] = null;
                ModelServer.get(uuid, function (e, s, so) {
                    if (err) {
                        self.log.error(e);
                        return;
                    }
                    s.modify({ status: 'unknown' }, function () {
                        self.log.warn(
                            { uuid: uuid },
                            'server no heartbeat from server in %d ' +
                            'seconds, status => unknown', 60000);
                    });
                });
            }, 90000);
        }

        self.refreshServerFromSysinfo(message, function (error) {
            if (error) {
                self.log.error(
                    error,
                    'Error updating server from startup sysinfo');
                return;
            }
            self.log.info(message, 'Server %s startup sysinfo', uuid);
        });
    });
};


/**
 * Compute nodes which are not in the 'setup' state, will periodically
 * broadcast their sysinfo payloads. On receipt of these messages, we will
 * check if we have any records of this server in moray. If it is found there,
 * ignore message. If it's not found in Moray, we need to add it.
 */

App.prototype.onServerSysinfo = function (message, routingKey) {
    var self = this;

    var uuid = routingKey.split('.')[2];
    self.log.debug('Ur sysinfo message received from %s', uuid);
    self.log.trace(message);

    ModelServer.get(uuid, function (err, servermodel, server) {
        if (err) {
            self.log.error(err, 'Error listing servers');
            return;
        }

        if (!server) {
            // Check if server not found in Moray, let's add it.
            self.refreshServerFromSysinfo(
                message,
                function (refreshError) {
                    if (refreshError) {
                        self.log.error(
                            refreshError,
                            'Error updating server from startup sysinfo');
                        return;
                    }
                    self.log.info(
                        message, 'Server %s startup sysinfo', uuid);
                });
        }

        if ((!server || !server.setup) && !self.statusTimeouts[uuid]) {
            clearTimeout(self.statusTimeouts[uuid]);

            self.statusTimeouts[uuid] = setTimeout(function () {
                self.statusTimeouts[uuid] = null;
                ModelServer.get(uuid, function (e, s, so) {
                    if (err) {
                        self.log.error(e);
                        return;
                    }
                    s.modify({ status: 'unknown' }, function () {
                        self.log.warn(
                            { uuid: uuid },
                            'server no heartbeat from server in %d ' +
                            'seconds, status => unknown', SYSINFO_PERIOD);
                    });
                });
            }, SYSINFO_PERIOD*1.5*1000);
        }

    });
};


/**
 * Moray
 */

App.prototype.getMoray = function () {
    return this.moray.getClient();
};


App.prototype.setMoray = function (moray) {
    this.moray = moray;
    return this.moray;
};


/**
 * Workflow
 */

App.prototype.getWorkflow = function () {
    return this.workflow;
};


App.prototype.setWorkflow = function (workflow) {
    this.workflow = workflow;
};


/**
 * Task Client
 */

App.prototype.getTaskClient = function () {
    return this.taskClient;
};


/**
 * Ur
 */

App.prototype.getUr = function () {
    return this.ur;
};


App.prototype.setUr = function (ur) {
    this.ur = ur;
    return ur;
};


/**
 * Misc
 */


App.prototype.getConfig = function () {
    return this.config;
};


App.prototype.getLog = function (callback) {
    return this.log;
};


module.exports = App;
