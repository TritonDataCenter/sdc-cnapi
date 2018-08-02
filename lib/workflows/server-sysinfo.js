/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This is the workflow responsible for processing a server's sysinfo.
 *
 * - CNAPI receives sysinfo
 * - CNAPI starts workflow
 * - Get server's pre-existing nics from NAPI
 * - Update NAPI with any changed nics and aggrs
 * - Add any new nics and aggrs to NAPI
 *
 * NICs are not deleted from NAPI by this workflow, which if required (e.g. a
 * swap of the physical NIC on the server) should be done directly by the
 * operator via the DeleteNic endpoint in NAPI.
 */

var VERSION = '1.1.3';

var sdcClients = require('sdc-clients');
var vasync = require('vasync');

// Prevent jsl from complaining.
var napiUrl = global.napiUrl;

function validateParams(job, callback) {
    if (!napiUrl) {
        callback(new Error('NAPI url not set in workflow runner config'));
        return;
    }

    if (!job.params.admin_uuid) {
        callback(new Error('Must specify admin_uuid'));
        return;
    }

    if (!job.params.server_uuid) {
        callback(new Error('Must specify server_uuid'));
        return;
    }

    if (!job.params.sysinfo) {
        callback(new Error('Must specify sysinfo'));
        return;
    }

    callback(null, 'Parameters validated');
}


// Query NAPI to see if the sysinfo nics already exist - necessary to catch
// the case where the nics do exist, but have a different owner
function getExistingNics(job, callback) {
    var sysinfo = job.params.sysinfo;
    var napi = new sdcClients.NAPI({ url: napiUrl });
    var macs = [];
    var n;

    for (n in sysinfo['Network Interfaces']) {
        macs.push(sysinfo['Network Interfaces'][n]['MAC Address']);
    }
    for (n in sysinfo['Virtual Network Interfaces']) {
        macs.push(sysinfo['Virtual Network Interfaces'][n]['MAC Address']);
    }

    job.params.existingNics = [];

    vasync.forEachParallel({
        inputs: macs,
        func: function (mac, next) {
            napi.getNic(mac, function (err, nic) {
                job.log.info({
                    nic: nic ? nic : '<unknown>',
                    res: err ? 'error: ' + err.message : 'success'
                }, 'got existing: ' + mac);

                if (err && err.statusCode !== 404) {
                    return next(err);
                }

                if (nic) {
                    job.params.existingNics.push(nic);
                }

                next();
            });
        }
    },
    function (err) {
        if (err) {
            return callback(err);
        }
        job.log.info(
            { existingNics: job.params.existingNics },
            'got existing nics from NAPI');
        return callback(null, 'Got existing nics from NAPI');
    });

}


function getExistingAggrs(job, cb) {
    var sysinfo = job.params.sysinfo;
    var napi = new sdcClients.NAPI({ url: napiUrl });
    var a;
    var aggr;
    var errs = [];
    var listed = 0;
    var macs = [];
    var m;
    var name;
    var sysAggr = {};
    var ids = [];

    job.params.existingAggrs = [];
    job.params.sysinfoAggrs = {};

    if (!sysinfo.hasOwnProperty('Link Aggregations')) {
        cb(null, 'No link aggregations in sysinfo');
        return;
    }

    for (name in sysinfo['Link Aggregations']) {
        aggr = sysinfo['Link Aggregations'][name];
        sysAggr = {};
        for (a in aggr) {
            sysAggr[a] = aggr[a];
        }
        job.params.sysinfoAggrs[name] = sysAggr;

        for (m in aggr.macs) {
            if (macs.indexOf(aggr.macs[m]) === -1) {
                macs.push(aggr.macs[m]);
            }
        }
    }

    function afterAggrList(err, aggrs) {
        if (err) {
            job.log.error(err, 'Error listing aggregations');
            errs.push(err);

        } else {
            job.log.info({ aggrs: aggrs }, 'retrieved existing aggregations');
            for (var ag in aggrs) {
                if (ids.indexOf(aggrs[ag].id) === -1) {
                    ids.push(aggrs[ag].id);
                    job.params.existingAggrs.push(aggrs[ag]);
                }
            }
        }

        if (++listed === 2) {
            if (errs.length !== 0) {
                cb(null, new Error('Error listing aggregations'));
            } else {
                job.log.info({
                    sysinfoAggrs: job.params.sysinfoAggrs,
                    existingAggrs: job.params.existingAggrs
                }, 'Got existing aggregations from NAPI');
                cb(null, 'Got existing aggregations from NAPI');
            }

            return;
        }
    }

    napi.listAggrs({ macs: macs }, afterAggrList);
    napi.listAggrs({ belongs_to_uuid: sysinfo.UUID }, afterAggrList);
}


function getServerNics(job, cb) {
    var napi = new sdcClients.NAPI({ url: napiUrl });
    napi.getNics(job.params.sysinfo['UUID'], function (err, nics) {
        if (err) {
            cb(err);
            return;
        }

        // Now that we have the current nics, go through and figure out
        // if they're adds, updates, or no change.
        var sysinfo = job.params.sysinfo;
        var uuid = sysinfo['UUID'];
        var aggrNics = [];
        var napiNics = {};
        var toAddNics = [];
        var toUpdateNics = [];
        var sysinfoAggrs = {};
        var sysinfoNics = {};
        var n;

        if (sysinfo.hasOwnProperty('Link Aggregations')) {
            for (n in sysinfo['Link Aggregations']) {
                sysinfoAggrs[n] = sysinfo['Link Aggregations'][n];
            }
        }

        for (n in sysinfo['Network Interfaces']) {
            if (sysinfoAggrs.hasOwnProperty(n)) {
                // Don't add if it's an aggregation
                aggrNics.push(n);

            } else {
                sysinfoNics[n] = sysinfo['Network Interfaces'][n];
            }
        }
        for (n in sysinfo['Virtual Network Interfaces']) {
            if (sysinfoAggrs.hasOwnProperty(n)) {
                // Don't add if it's an aggregation
                aggrNics.push(n);

            } else {
                sysinfoNics[n] = sysinfo['Virtual Network Interfaces'][n];
            }
        }

        if (aggrNics.length !== 0) {
            job.log.info({ aggrs: aggrNics },
                'Skipped adding interfaces because they are link aggregations');
        }

        for (n in nics) {
            napiNics[nics[n].mac] = nics[n];
        }
        for (n in job.params.existingNics) {
            napiNics[job.params.existingNics[n].mac]
                = job.params.existingNics[n];
        }

        var listEqual;

        for (n in sysinfoNics) {
            var sysinfoNic = sysinfoNics[n];
            var napiNic = napiNics[sysinfoNic['MAC Address']];
            var newNic = {};

            job.log.info({ sysinfoNic: sysinfoNic, napiNic: napiNic },
                'Checking nic for changes: ' + sysinfoNic['MAC Address']);

            if (!napiNic) {
                newNic = {
                  mac: sysinfoNic['MAC Address'],
                  belongs_to_uuid: uuid,
                  belongs_to_type: 'server',
                  owner_uuid: job.params.admin_uuid
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

            if (sysinfoNic.ip4addr && (napiNic.ip !== sysinfoNic.ip4addr)) {
                newNic.ip = sysinfoNic.ip4addr;
            }

            if (napiNic.belongs_to_uuid !== uuid) {
                newNic.belongs_to_uuid = uuid;
            }

            if (napiNic.belongs_to_type !== 'server') {
                newNic.belongs_to_type = 'server';
            }

            // This can't be declared outside of this function, otherwise it
            // can't be seen when running in a workflow
            listEqual = function (a, b) {
                if (!a && !b) {
                    return true;
                }

                if (!a || !b || (a.length !== b.length)) {
                    return false;
                }

                a.sort();
                b.sort();

                for (var i = 0; i < a.length; i++) {
                    if (a[i] !== b[i]) {
                        return false;
                    }
                }

                return true;
            };

            if (Object.keys(newNic).length !== 0) {
                newNic.mac = sysinfoNic['MAC Address'];
                toUpdateNics.push(newNic);
            }

            delete napiNics[sysinfoNic['MAC Address']];
        }

        job.params.updateNics = toUpdateNics;
        job.params.addNics = toAddNics;

        job.log.info({
            updateNics: toUpdateNics,
            addNics: toAddNics,
            napiNics: nics
        }, 'Got old nics from NAPI');

        cb(null, 'Got old nics from NAPI');
        return;
    });
}


function createNicTags(job, callback) {
    var napi = new sdcClients.NAPI({ url: napiUrl });
    var sysinfo = job.params.sysinfo;
    var tags = [];
    var tag;

    for (var n in sysinfo['Network Interfaces']) {
        var nic = sysinfo['Network Interfaces'][n];
        if (nic.hasOwnProperty('NIC Names')) {
            for (var t in nic['NIC Names']) {
                tag = nic['NIC Names'][t];

                if (tags.indexOf(tag) === -1) {
                    tags.push(tag);
                }
            }
        }
    }

    if (tags.length === 0) {
        callback(null, 'No nic tags to create in NAPI');
        return;
    }

    vasync.forEachParallel({
        inputs: tags,
        func: function (tagparam, next) {
            napi.createNicTag(tagparam, function (err, res) {
                if (err) {
                   if (!(err.body && err.body.errors &&
                       err.body.errors[0].code === 'Duplicate')) {
                       job.log.error(err, 'Error adding nic tag %s to NAPI',
                           tagparam);
                       return next(err);
                   }
                }
                next();
            });
        }
    },
    function (err) {
        if (err) {
            return callback(err);
        }
        callback(null, 'added nic tags to NAPI');
    });
}


function updateNics(job, callback) {
    var length = job.params.updateNics.length;
    if (length === 0) {
        callback(null, 'No nics to update: returning');
        return;
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });
    var updated = [];

    vasync.forEachParallel({
        inputs: job.params.updateNics,
        func: function (params, next) {
            napi.updateNic(params.mac, params, function (err, nic) {
                job.log.info({
                    res: nic,
                    params: params,
                    status: err ? 'error: ' + err.message : 'success'
                }, 'updated nic: ' + params.mac);
                if (err) {
                    next(err);
                    return;
                }
                updated.push(params.mac);
                next();
            });
        }
    },
    function (err) {
        if (err) {
            return callback(err);
        }
        callback(null, 'nics updated: ' + updated.join(', '));
        return;
    });
}


function addNics(job, callback) {
    var length = job.params.addNics.length;
    if (length === 0) {
        callback(null, 'No nics to add: returning');
        return;
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });
    var added = [];

    vasync.forEachParallel({
        inputs: job.params.addNics,
        func: function (params, next) {
            napi.createNic(params.mac, params, function (err, nic) {
                job.log.info({
                    res: nic,
                    params: params,
                    status: err ? 'error: ' + err.message : 'success'
                }, 'added nic: ' + params.mac);
                if (err) {
                    next(err);
                    return;
                }
                added.push(params.mac);
                next();
            });
        }
    },
    function (err) {
        if (err) {
            return callback(err);
        }
        callback(null, 'nics added: ' + added.join(', '));
        return;
    });
}


function updateAggrs(job, cb) {
    if (job.params.existingAggrs.length === 0 &&
        Object.keys(job.params.sysinfoAggrs).length === 0) {
        cb(null, 'No aggregations found');
        return;
    }
    var a;
    var add = [];
    var aggr;
    var beforeAggrs = {};
    var update = [];
    var serverUUID = job.params.sysinfo.UUID;
    var sysinfoNics = job.params.sysinfo['Network Interfaces'];

    for (a in job.params.existingAggrs) {
        aggr = job.params.existingAggrs[a];
        if (aggr.belongs_to_uuid == serverUUID) {
            beforeAggrs[aggr.name] = aggr;
        }
    }

    for (a in job.params.sysinfoAggrs) {
        aggr = job.params.sysinfoAggrs[a];
        var params = {
            id: serverUUID + '-' + a,
            lacp_mode: aggr['LACP mode'] || 'off',
            macs: aggr.Interfaces.map(function (i) {
                return sysinfoNics[i]['MAC Address'];
            }),
            name: a
        };

        if (beforeAggrs.hasOwnProperty(a)) {
            update.push(params);
        } else {
            add.push(params);
        }
    }

    if (update.length === 0 && add.length === 0) {
        cb(null, 'No aggregations to update');
        return;
    }

    var errs = [];
    var napi = new sdcClients.NAPI({ url: napiUrl });
    var totalActions = add.length + update.length;
    var doneActions = 0;

    job.log.info({ add: add, update: update },
        'Updating aggregations in NAPI');

    for (a in add) {
        napi.createAggr(add[a], afterAction.bind(napi, 'add', add[a]));
    }

    for (a in update) {
        napi.updateAggr(update[a].id, update[a],
            afterAction.bind(napi, 'update', update[a]));
    }

    function afterAction(action, actParams, err, res) {
        if (err) {
            job.log.error(err, 'NAPI %s error', action);
            errs.push(err);
        } else {
            job.log.info({ params: actParams, res: res },
                'NAPI %s success', action);
        }

        if (++doneActions == totalActions) {
            if (errs.length !== 0) {
                cb(new Error('Error updating aggregations in NAPI'));
            } else {
                cb(null, 'Successfully updated aggregations in NAPI');
            }

            return;
        }
    }
}


function setMocks(obj) {
    if (obj.hasOwnProperty('napiUrl')) {
        napiUrl = obj.napiUrl;
    }

    if (obj.hasOwnProperty('sdcClients')) {
        sdcClients = obj.sdcClients;
    }
}


module.exports = {
    name: 'server-sysinfo-' + VERSION,
    version: VERSION,
    onerror: [
        {
            name: 'onerror',
            body: function (job, cb) {
                cb(new Error('Error executing job'));
            }
        }
    ],

    chain: [
        {
            name: 'cnapi.validate_params',
            timeout: 10,
            retry: 1,
            body: validateParams
        },
        {
            name: 'napi.get_existing_nics',
            timeout: 10,
            retry: 1,
            body: getExistingNics
        },
        {
            name: 'napi.get_existing_aggrs',
            timeout: 10,
            retry: 1,
            body: getExistingAggrs,
            modules: { sdcClients: 'sdc-clients', vasync: 'vasync' }
        },
        {
            name: 'napi.get_old_server_nics',
            timeout: 10,
            retry: 1,
            body: getServerNics
        },
        {
            name: 'napi.create_nictags',
            timeout: 10,
            retry: 1,
            body: createNicTags,
            modules: { sdcClients: 'sdc-clients', vasync: 'vasync' }
        },
        {
            name: 'napi.update_nics',
            timeout: 10,
            retry: 1,
            body: updateNics,
            modules: { sdcClients: 'sdc-clients', vasync: 'vasync' }
        },
        {
            name: 'napi.add_nics',
            timeout: 10,
            retry: 1,
            body: addNics,
            modules: { sdcClients: 'sdc-clients', vasync: 'vasync' }
        },
        {
            name: 'napi.update_aggrs',
            timeout: 10,
            retry: 1,
            body: updateAggrs
        }
    ],
    _setMocks: setMocks
};
