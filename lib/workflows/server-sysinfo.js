/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * This is the workflow responsible for processing a server's sysinfo.
 *
 * - CNAPI receives sysinfo
 * - CNAPI starts workflow
 * - Get server's pre-existing nics from NAPI
 * - Update NAPI with any changed nics
 * - Add any new nics to NAPI
 * - Delete any removed nics from NAPI
 */

var VERSION = '1.0.0';

var sdcClients = require('sdc-clients');
var restify = require('restify');

function validateParams(job, callback) {
    if (!napiUrl) {
        callback(new Error('NAPI url not set in workflow runner config'));
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
function getExistingNics(job, cb) {
    var sysinfo = job.params.sysinfo;
    var napi = new sdcClients.NAPI({ url: napiUrl });
    var macs = [];
    var queried = 0;
    var n;

    for (n in sysinfo['Network Interfaces']) {
        macs.push(sysinfo['Network Interfaces'][n]['MAC Address']);
    }
    for (n in sysinfo['Virtual Network Interfaces']) {
        macs.push(sysinfo['Virtual Network Interfaces'][n]['MAC Address']);
    }

    job.params.existingNics = [];

    for (var i = 0; i < macs.length; i++) {
        var mac = macs[i];
        napi.getNic(mac, function (err, nic) {
            queried++;
            job.log.info({
                nic: nic ? nic : '<unknown>',
                res: err ? 'error: ' + err.message : 'success'
            }, 'got existing: ' + mac);

            if (err && err.httpCode != 404) {
                cb(err);
                return;
            }

            if (nic) {
                job.params.existingNics.push(nic);
            }

            if (queried == macs.length) {
                job.log.info(job.params.existingNics,
                    'Got existing nics from NAPI');
                cb(null, 'Got existing nics from NAPI');
                return;
            }

        });
    }
}


function getServerNics(job, cb) {
    var napi = new sdcClients.NAPI({ url: napiUrl });
    napi.getNics(job.params.sysinfo['UUID'], function (err, nics) {
        if (err) {
            cb(err);
            return;
        }

        // Now that we have the current nics, go through and figure out
        // if they're adds, deletes, updates, or no change.
        var sysinfo = job.params.sysinfo;
        var uuid = sysinfo['UUID'];
        var napiNics = {};
        var toAddNics = [];
        var toUpdateNics = [];
        var sysinfoNics = {};
        var n;

        for (n in sysinfo['Network Interfaces']) {
            sysinfoNics[n] = sysinfo['Network Interfaces'][n];
        }
        for (n in sysinfo['Virtual Network Interfaces']) {
            sysinfoNics[n] = sysinfo['Virtual Network Interfaces'][n];
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
                  owner_uuid: '00000000-0000-0000-0000-000000000000'
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

            if (napiNic.ip != sysinfoNic.ip4addr) {
                newNic.ip = sysinfoNic.ip4addr;
            }

            if (napiNic.belongs_to_uuid != uuid) {
                newNic.belongs_to_uuid = uuid;
            }

            if (napiNic.belongs_to_type != 'server') {
                newNic.belongs_to_type = 'server';
            }

            // This can't be declared outside of this function, otherwise it
            // can't be seen when running in a workflow
            listEqual = function (a, b) {
                if (!a && !b) {
                    return true;
                }

                if (!a || !b || (a.length != b.length)) {
                    return false;
                }

                a.sort();
                b.sort();

                for (var i = 0; i < a.length; i++) {
                    if (a[i] != b[i]) {
                        return false;
                    }
                }

                return true;
            };

            var equal =
                listEqual(sysinfoNic['NIC Names'], napiNic.nic_tags_provided);

            if (sysinfoNic.hasOwnProperty('NIC Names') && !equal) {
                newNic.nic_tags_provided = sysinfoNic['NIC Names'];
            }

            if (Object.keys(newNic).length !== 0) {
                newNic.mac = sysinfoNic['MAC Address'];
                toUpdateNics.push(newNic);
            }

            delete napiNics[sysinfoNic['MAC Address']];
        }

        job.params.updateNics = toUpdateNics;
        job.params.addNics = toAddNics;
        job.params.deleteNics =
            Object.keys(napiNics).map(function (i) { return napiNics[i]; });
        job.log.info({
            updateNics: toUpdateNics,
            addNics: toAddNics,
            deleteNics: job.params.deleteNics,
            napiNics: nics
        }, 'Got old nics from NAPI');

        cb(null, 'Got old nics from NAPI');
        return;
    });
}


function updateNics(job, cb) {
    var length = job.params.updateNics.length;
    if (length === 0) {
        cb(null, 'No nics to update: returning');
        return;
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });
    var updated = [];

    for (var i = 0; i < length; i++) {
        var params = job.params.updateNics[i];
        napi.updateNic(params.mac, params, function (err, nic) {
            job.log.info({
                res: nic,
                params: params,
                status: err ? 'error: ' + err.message : 'success'
            }, 'updated nic: ' + params.mac);
            if (err) {
                cb(err);
                return;
            }
            updated.push(params.mac);

            if (updated.length == length) {
                cb(null, 'Nics updated: ' + updated.join(', '));
                return;
            }
        });
    }
}


function addNics(job, cb) {
    var length = job.params.addNics.length;
    if (length === 0) {
        cb(null, 'No nics to add: returning');
        return;
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });
    var added = [];

    for (var i = 0; i < length; i++) {
        var params = job.params.addNics[i];
        napi.createNic(params.mac, params, function (err, nic) {
            job.log.info({
                res: nic,
                params: params,
                status: err ? 'error: ' + err.message : 'success'
            }, 'added nic: ' + params.mac);
            if (err) {
                cb(err);
                return;
            }
            added.push(params.mac);

            if (added.length == length) {
                cb(null, 'Nics added: ' + added.join(', '));
                return;
            }
        });
    }
}


function deleteNics(job, cb) {
    var length = job.params.deleteNics.length;
    if (length === 0) {
        cb(null, 'No nics to delete: returning');
        return;
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });
    var deleted = [];

    for (var i = 0; i < length; i++) {
        var params = job.params.deleteNics[i];
        napi.deleteNic(params.mac, function (err) {
            job.log.info({
                params: params,
                status: err ? 'error: ' + err.message : 'success'
            }, 'deleted nic: ' + params.mac);
            if (err) {
                cb(err);
                return;
            }
            deleted.push(params.mac);

            if (deleted.length == length) {
                cb(null, 'Nics deleted: ' + deleted.join(', '));
                return;
            }
        });
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
            name: 'cnapi.get_existing_nics',
            timeout: 10,
            retry: 1,
            body: getExistingNics
        },
        {
            name: 'cnapi.get_old_server_nics',
            timeout: 10,
            retry: 1,
            body: getServerNics
        },
        {
            name: 'cnapi.update_nics',
            timeout: 10,
            retry: 1,
            body: updateNics
        },
        {
            name: 'cnapi.add_nics',
            timeout: 10,
            retry: 1,
            body: addNics
        },
        {
            name: 'cnapi.delete_nics',
            timeout: 10,
            retry: 1,
            body: deleteNics
        }
    ]
};
