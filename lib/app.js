/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This is where the core of CNAPI abstractions and logic is defined.
 */


var assert = require('assert-plus');
var async = require('async');
var crypto = require('crypto');
var deepEqual = require('deep-equal');
var execFile = require('child_process').execFile;
var fs = require('fs');
var http = require('http');
var https = require('https');
var VError = require('verror');
var Logger = require('bunyan');
var restify = require('restify');
var sdcClients = require('sdc-clients');
var sprintf = require('sprintf').sprintf;
var util = require('util');
var once = require('once');

var amqp = require('amqp');
var buckets = require('./apis/moray').BUCKETS;
var common = require('./common');
var createServer = require('./server').createServer;
var Designation = require('./designation');
var EffluentLogger = require('effluent-logger');
var ModelBase = require('./models/base');
var ModelImage = require('./models/image');
var ModelPlatform = require('./models/platform');
var ModelWaitlist = require('./models/waitlist');
var ModelServer = require('./models/server');
var ModelVM = require('./models/vm');
var Moray = require('./apis/moray');
var Ur = require('./ur');
var Workflow = require('./apis/workflow');



var TASK_CLEANUP_MAX_AGE = 30 * 24 * 60 * 60;
var TASK_CLEANUP_PERIOD = 60 * 60;
var SYSINFO_PERIOD = 60;



function addFluentdHost(log, host) {
    var evtLogger = new EffluentLogger({
        filter: function _evtFilter(obj) { return (!!obj.evt); },
        host: host,
        log: log,
        port: 24224,
        tag: 'debug'
    });
    log.addStream({
        stream: evtLogger,
        type: 'raw'
    });
}


function App(config, opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.metricsManager, 'opts.metricsManager');

    self.config = config;
    self.log = opts.log;

    // EXPERIMENTAL
    if (config.fluentd_host) {
        addFluentdHost(self.log, config.fluentd_host);
    }

    self.serversNeedSysinfo = {};

    self.log.info({ config: config }, 'cnapi config');
    self.config.log = self.log;
    self.collectedGlobalSysinfo = false;
    self.metricsManager = opts.metricsManager;
    self.taskCallbacks = {};

    ModelBase.init(self);
    ModelImage.init(self);
    ModelPlatform.init(self);
    ModelServer.init(self);
    ModelWaitlist.init(self);
    ModelVM.init(self);

    Designation.init(self);

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
 * # Setup metrics
 *
 * This will setup a node-triton-metrics instance and connect it to the restify
 * server.
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
            execFile('/opt/local/bin/uname', ['-v'],
                function (error, stdout, stderr) {
                    if (error) {
                        wfcb(error);
                        return;
                    }

                    var uname_re = /^joyent_(\d{8}T\d{6}Z)$/m;

                    stdout = stdout.toString();

                    var match = stdout.trim().match(uname_re);
                    if (!match) {
                        wfcb(new VError(util.format(
                            'could not parse uname -v output: %j',
                            stdout)));
                        return;
                    }

                    self.liveimage = match[1];
                    wfcb();
                });
        },
        function (wfcb) {
            self.initializeHttpInterface(wfcb);
        },
        function _setupMetrics(wfcb) {
            // Since initializeHttpInterface() setup self.server, we can now
            // attach the metrics manager to that restify server instance.
            self.server.on('after', self.metricsManager.collectRestifyMetrics
                .bind(self.metricsManager));
            wfcb();
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


App.prototype.startTaskCleaner = function (uuid) {
    var self = this;

    schedule();

    function schedule() {
        self.taskCleanerTimeout = setTimeout(
            cleanup, TASK_CLEANUP_PERIOD * 1000);
    }

    function cleanup() {
        schedule();

        var ts = Date.now();
        var then = ts - TASK_CLEANUP_MAX_AGE * 1000;
        var thenDate = new Date(then);
        var escts = common.filterEscape(thenDate.toISOString());
        self.log.warn('cleaning up tasks with timestamp older than = %s',
                      escts);

        var filter = sprintf('(!(timestamp>=%s))', escts);

        var moray = ModelWaitlist.getMoray();

        moray.deleteMany(buckets.tasks.name, filter, function (error) {
            if (error) {
                self.log.error(error, 'failed to clean up tasks older than %s',
                               thenDate.toISOString());
                return;
            }
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
    self.setupServerHeartbeatTimeouts();

    self.setupAmqpClient();
    self.startSysinfoChecker();
    self.startTaskCleaner();

    callback();
};


/**
 * Sets up timeouts, which when fired will trigger a server's status to be
 * marked as "unknown". The timeouts are cleared and reinitiated after every
 * heartbeat.
 */

App.prototype.setupServerHeartbeatTimeouts = function () {
    var self = this;

    wait();

    function wait() {
        async.until(
            function () {
                return self.moray.connected;
            }, function (cb) {
                setTimeout(cb, 1000);
            }, onMorayConnection);
    }

    function onMorayConnection() {
        var listopts = {};

        // List all servers in moray
        ModelServer.list(listopts, function (error, servers) {
            if (error) {
                self.log.warn(
                    error,
                    'error attempting to list servers for heartbeat timeouts');
                setTimeout(function () {
                    wait();
                }, 5000);
                return;
            }

            if (!servers) {
                self.log.error(
                    'no servers or errors returned');
                return;
            }

            // For every server, set a timeout using
            // self.onServerHeartbeatTimeoutExpired
            async.forEach(
                servers,
                function (server) {
                    self.refreshServerHeartbeatTimeout(server.uuid);
                });
        });
    }
};


/**
 * For a given server, this clears and refreshes to the maximum duration the
 * timeout which amongst other things marks a server's status as "unknown".
 */

App.prototype.refreshServerHeartbeatTimeout = function (uuid) {
    var self = this;

    clearTimeout(self.statusTimeouts[uuid]);
    self.statusTimeouts[uuid] = setTimeout(function () {
        var server = new ModelServer(uuid);
        server.onHeartbeatTimeoutExpired();
    }, common.HEARTBEATER_PERIOD * 2 * 1000);
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

    connection.on('ready', function () {
        connection.connected = true;
        self.log.info('AMQP connection ready');

        self.moray.ensureClientReady(function () {

            self.ur.useConnection(self.amqpConnection);
            self.ur.bindQueues();

            self.collectGlobalSysinfo(function () {
                self.collectedGlobalSysinfo = true;
            });
        });
    });

    connection.on('error', function (e) {
        connection.connected = false;
        self.log.error(e);
    });

    connection.on('end', function () {
        connection.connected = false;
    });

    // Set up Ur client.
    self.log.debug('Ready to communicate with ur');
    self.ur = new Ur({ log: self.log });
    self.ur.on('serverStartup', self.onSysinfoReceivedUr.bind(self));
    self.ur.on('serverSysinfo', self.onSysinfoReceivedUr.bind(self));
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


App.prototype.onVmsUpdate = function (uuid, heartbeat, callback) {
    var self = this;

    self.log.trace(heartbeat, 'vms update');
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
        callback();
        return;
    }

    ModelServer.get(uuid, function (err, server, serverobj) {
        if (err) {
            self.log.error({ err: err, uuid: uuid },
              'could not look up server in moray');
            callback();
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
                        new VError(
                        updateError,
                        'updating server record with heartbeat'));
                    return;
                }

                callback();
            });
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
        connectTimeout: 5000
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

        if (!server.created) {
            if (created) {
                server.created = created;
            } else {
                server.created = (new Date()).toISOString();
            }
        }

        // Update the hostname only if the server's sysinfo boot time is
        // different than that which we have stored in moray. This is to
        // prevent the situation where we set a hostname during the setup
        // workflow, and we get a periodic sysinfo message which causes the
        // hostname value in moray to get overridden.

        if (server.sysinfo &&
            (server.sysinfo['Boot Time'] !== sysinfo['Boot Time']))
        {
            server.hostname = sysinfo['Hostname'];
        }

        server.current_platform = sysinfo['Live Image'];
        server.transitional_status = '';

        self.log.debug({sysinfo: sysinfo}, 'Server %s existed in moray', uuid);

        async.waterfall([
            function (cb) {
                if (!server.setup && !sysinfo.hasOwnProperty('Setup')) {
                    shouldInspectServer = true;
                }

                if (sysinfo['SDC Version'] !== '7.0' &&
                       (!server.sysinfo ||
                        !server.sysinfo.hasOwnProperty('Zpool') ||
                        !sysinfo.hasOwnProperty('Zpool') ||
                        !sysinfo.hasOwnProperty('Zpool Creation')))
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
        if (!sysinfo['Setup'] && sysinfo['SDC Version'] !== '7.0') {
            self.log.info('New server %s missing sysinfo.Setup', uuid);
            shouldInspectServer = true;
        }

        if (!sysinfo['Zpool'] && sysinfo['SDC Version'] !== '7.0') {
            self.log.info('New server %s missing sysinfo.Zpool', uuid);
            shouldInspectServer = true;
        }

        if (!sysinfo['Zpool Creation'] && sysinfo['SDC Version'] !== '7.0') {
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

App.prototype.onSysinfoReceivedUr =
function onSysinfoReceivedUr(message, routingKey) {
    var self = this;
    var serverUuid = routingKey.split('.')[2];

    return self.onSysinfoReceived(serverUuid, message);
};

/**
 * Compute nodes which are not in the 'setup' state, will periodically
 * broadcast their sysinfo payloads. On receipt of these messages, we will
 * check if we have any records of this server in moray. If it is found there,
 * ignore message. If it's not found in Moray, we need to add it.
 */

App.prototype.onSysinfoReceived =
function onSysinfoReceived(serverUuid, newSysinfo, callback) {
    var self = this;

    var sysinfoTimeoutSeconds = 90;
    self.log.info('new sysinfo received for %s', serverUuid);
    self.log.debug({sysinfo: newSysinfo}, 'sysinfo for %s', serverUuid);

    var serverValues;

    async.waterfall([
        function (next) {
            // If server exists and is not setup, clear and set a timeout to
            // set status to unknown. This way will need to periodically send
            // out sysinfo messages or it will be marked as status = 'unknown'.
            ModelServer.get(serverUuid, function (e, s, values) {
                if (e) {
                    next(e);
                    return;
                }

                serverValues = values;
                if (values && !values.setup) {
                    setStatusTimeout();
                }

                next();
            });
        },
        function (next) {
            // Initiate a sysinfo workflow for server
            if (self.workflow.connected) {
                if (!serverValues ||
                    !deepEqual(newSysinfo, serverValues.sysinfo))
                {
                    self.log.info(
                        'starting server-sysinfo workflow for changed sysinfo');
                    ModelServer.beginSysinfoWorkflow(newSysinfo);
                } else {
                    self.log.debug(
                        { uuid: serverUuid},
                        'skipping server-sysinfo workflow ' +
                        'for sysinfo with no changes');
                }
            } else {
                self.log.error({ uuid: serverUuid},
                    'could not create sysinfo workflow: workflow unavailable');
            }
            next();
        },
        function (next) {
            self.refreshServerFromSysinfo(newSysinfo, function (error) {
                if (error) {
                    next(error);
                    return;
                }
                next();
            });
        }
    ],
    function (err) {
        if (err) {
            self.log.error(err, 'error handling sysinfo message');
        }
        self.log.debug('sysinfo handler complete for %s', serverUuid);

        if (callback) {
            callback(err);
        }
    });

    function setStatusTimeout() {
        clearTimeout(self.statusTimeouts[serverUuid]);

        self.statusTimeouts[serverUuid] = setTimeout(function () {
            self.statusTimeouts[serverUuid] = null;
            ModelServer.get(serverUuid, function (e, s, so) {
                if (e) {
                    self.log.error(e);
                    return;
                }
                if (!so) {
                    self.log.error(e,
                        'wanted to update status for sever %s ' +
                        'but it was not found in moray');
                    return;
                }

                s.modify({ status: 'unknown' }, function () {
                    self.log.warn(
                        { uuid: serverUuid },
                        'no sysinfo from server in %d ' +
                        'seconds, status => unknown',
                        sysinfoTimeoutSeconds);
                });
            });
        }, sysinfoTimeoutSeconds * 1000);
    }
};

/* BEGIN JSSTYLED */
/*
 * Set a callback to be executed when a cn-agent task has completed. This
 * allows upstream clients to initiate a task and then wait for it to complete,
 * without needing to poll periodically.
 *
 * @param opts {Object}
 * @param opts.taskid {String}
 * @param opts.timeoutSeconds {Number} How long to wait before we consider this task timed out
 * @param callback {Function} Function to call on task completion
 */
/* END JSSTYLED */

App.prototype.waitForTask = function (opts, callback) {
    var self = this;
    var taskid = opts.taskid;
    var timeoutSeconds = opts.timeoutSeconds || 3600;

    assert.object(opts, 'opts');
    assert.string(opts.taskid, 'opts.taskid');
    assert.optionalNumber(opts.timeoutSeconds, 'opts.timeoutSeconds');
    assert.func(callback, 'callback');

    if (!self.taskCallbacks.hasOwnProperty(taskid)) {
        self.taskCallbacks[taskid] = {
            callbacks: []
        };
    }

    // Check if there is a cached response for this task.
    if (self.taskCallbacks[taskid].task) {
        self.log.debug({ cached: self.taskCallbacks[taskid].task },
            'waitForTask: returning a cached task value');
        callback(null, self.taskCallbacks[taskid].task);
        return;
    }

    self.log.debug('waitForTask: no cached value found');

    /**
     * Generate an id so we can find our way back to a particular callback when
     * it comes to time expire it.
     */
    var id = crypto.createHash('sha1').update(
                crypto.randomBytes(128)).digest('hex');

    var timeout = setTimeout(function () {
        for (var idx in self.taskCallbacks[taskid].callbacks) {
            if (self.taskCallbacks[taskid].callbacks[idx].id === id) {

                self.taskCallbacks[taskid].callbacks[idx].fn(new Error(
                    'wait timed out after ' + timeoutSeconds));

                // Remove the matching callback from the list
                self.taskCallbacks[taskid].callbacks.splice(idx, 1);

                if (self.taskCallbacks[taskid].callbacks.length === 0) {
                    delete self.taskCallbacks[taskid];
                }
                break;
            }

            if (self.taskCallbacks[taskid].callbacks.length === 0) {
                delete self.taskCallbacks[taskid];
            }
        }
    }, timeoutSeconds * 1000);

    var obj = { id: id, timeout: timeout, fn: once(callback) };
    self.taskCallbacks[taskid].callbacks.push(obj);
};


/**
 * This function is called when we want to let any waiting callbacks know that
 * a cn-agent task we initiated has completed.
 */

App.prototype.alertWaitingTasks = function (err, taskid, task) {
    var self = this;

    assert.optionalObject(err, 'err');
    assert.string(taskid, 'taskid');
    assert.object(task, 'task');

    /**
     * If no callbacks were set for this task response when we go to alert
     * waiting callbacks, cache the value in case we end up trying to wait for
     * this task to finish after it has already done so.
     *
     * This can happen if the task finishes after we do the initial 'get' for
     * the task, but before we can wait on it. In such a situation, we cache
     * the task values so we can return it for subsequent waits.
     */

    if (!self.taskCallbacks.hasOwnProperty(taskid) ||
            self.taskCallbacks[taskid].callbacks.length === 0)
    {
        self.log.debug(
            'alertWaitingTasks: wanted to alert callbacks for task %s, '
            + 'but none found, caching response', taskid);

        var timeout = setTimeout(function () {
            delete self.taskCallbacks[taskid];
        }, TASK_CLEANUP_PERIOD * 1000).unref();

        self.taskCallbacks[taskid] = {
            task: task,
            callbacks: [],

            /**
             * This timer ensures this cached value gets cleaned-up if no one
             * checks and disposes of it before the expiry.
             */
            cleanupTimeout: timeout
        };

        return;
    }

    var toAlert = self.taskCallbacks[taskid].callbacks;

    for (var idx in toAlert) {
        clearTimeout(toAlert[idx].timeout);
        toAlert[idx].fn(err, task);
    }

    delete self.taskCallbacks[taskid];
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
