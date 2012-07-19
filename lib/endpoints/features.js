/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * features.js: Server features endpoints
 */

var mod_async = require('async');
var mod_https = require('https');
var mod_fs = require('fs');
var mod_path = require('path');
var mod_restify = require('restify');
var mod_url = require('url');
var mod_uuid = require('node-uuid');

var execFile = require('child_process').execFile;
var sprintf = require('sprintf').sprintf;

/*
 * Server feature definitions
 * XXX These will eventually live in UFDS, but for now, they're hardcoded here.
 */

/* Parameters common to every provisioned appliance */
var COMMON_PARAMS = {
    brand: 'joyent-minimal',
    networks: [ 'admin' ],
    nowait: true
};

var APPLIANCES = {
    manta_storage: {
        user_script: 'storage.sh',
        appliance: 'mako',
        params: {
            delegate_dataset: true,
            quota: 0,
            ram: 128,
            tags: {
                sds_role: 'storage',
                domain: 'storage.100'
            }
        }
    },
    manta_nameservice: {
        user_script: 'nameservice.sh',
        appliance: 'binder',
        params: {
            ram: 256,
            tags: {
                sds_role: 'nameservice'
            }
        }
    },
    manta_postgres: {
        user_script: 'postgres.sh',
        appliance: 'manatee',
        params: {
            delegate_dataset: true,
            quota: 50,
            ram: 1024,
            tags: {
                sds_role: 'postgres',
                lb_service: 'idontknowhwatgoeshere'
            }
        }
    },
    manta_moray: {
        user_script: 'moray.sh',
        appliance: 'moray',
        params: {
            ram: 1024,
            tags: {
                sds_role: 'moray',
                moray_service: 'idontknowhwatgoeshere'
            }
        }
    },
    manta_loadbalancer: {
        user_script: 'loadbalancer.sh',
        appliance: 'muppet',
        params: {
            ram: 128,
            tags: {
                sds_role: 'loadbalancer',
                moray_service: 'idontknowhwatgoeshere'
            }
        }
    },
    manta_webapi: {
        user_script: 'webapi.sh',
        appliance: 'muskie',
        params: {
            ram: 768,
            tags: {
                sds_role: 'webapi',
                moray_service: 'idontknowhwatgoeshere'
            }
        }
    },
    manta_jobworker: {
        user_script: 'jobworker.sh',
        appliance: 'marlin',
        params: {
            ram: 128,
            tags: {
                sds_role: 'jobworker',
                domain: 'idontknowhwatgoeshere'
            }
        }
    }
};

var IMAGES = [
    'binder',
    'mako',
    'manatee',
    'mahi',
    'marlin',
    'moray',
    'muppet',
    'muskie'
];

var IMAGE_PATH = '/builds/%s/master-latest/%s/';
var STUFF_CREDS = 'guest:GrojhykMid';
var STUFF_URL = 'https://10.2.0.190/stuff';

var OWNER_ACCOUNT_UUID = '930896af-bf8c-48d4-885c-6573a94b1853';
var CNAPI_UUID = '';

var TMP_DIR = '/var/tmp';
var SCRIPTS_DIR = '/opt/smartdc/cnapi/scripts/manta';

var IMGADM = '/usr/sbin/imgadm';
var VMADM = '/usr/sbin/vmadm';
var ZONENAME = '/usr/bin/zonename';

function domainToPath(domain) {
    return ('/' + domain.split('.').reverse().join('/'));
}

// Fisher-Yates shuffle
// http://sedition.com/perl/javascript-fy.html
function shuffle(arr) {
        if (arr.length === 0)
                return (arr);

        var i = arr.length;
        while (--i > 0) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = arr[i];
                arr[i] = arr[j];
                arr[j] = tmp;
        }

        return (arr);
}

function stuffURL(image, file) {
    return (sprintf('%s' + IMAGE_PATH + '%s',
        STUFF_URL, image, image, file));
}

function stuffGet(image, callback) {
    var self = this;
    var url = sprintf('%s' + IMAGE_PATH, STUFF_URL, image, image);
    var obj = mod_url.parse(url);
    obj.auth = STUFF_CREDS;
    obj.port = obj.port || 443;

    var req = mod_https.get(obj, function (res) {
        if (res.statusCode !== 200) {
            self.log.error('stuff(%s) HTTP error: %d',
                obj.href, res.statusCode);
            return (callback(new mod_restify.InternalError('cannot ' +
                'get %s from stuff: %d', obj.href, res.statusCode)));
        }

        return (callback(res));
    });
    req.on('error', function (err) {
        console.error('stuff(%s) client error: %s',
            obj.href, err.stack);
        return (callback(err));
    });
    return (req);
}

/*
 * Find links to the latest file and manifest for a given image.
 */
function stuffLinks(image, callback) {
    stuffGet(image, function (res) {
        res.setEncoding('utf8');
        res.body = '';
        res.on('data', function (chunk) {
            res.body += chunk;
        });
        res.on('end', function () {
            /* JSSTYLED */
            var re = /<a href="(.+)">/g;
            var tmp;
            var links = [];
            while ((tmp = re.exec(res.body)))
                links.push(tmp[1]);

            var result = {};
            links.forEach(function (link) {
                if (/\.zfs.bz2$/.test(link))
                    result.image = link;
                else if (/\.dsmanifest$/.test(link))
                    result.manifest = link;
                else if (/\.tar.bz2$/.test(link) && image === 'marlin')
                    result.pkg = link;
            });

            callback(null, result);
        });
    });
}

function downloadAndInstallImage(model, server, image, callback) {
    var self = this;
    var image_file, image_manifest, image_pkg = null;
    var exists = false;
    var props = {};

    mod_async.waterfall([
        /* Find zonename for CNAPI zone */
        function (wf$cb) {
            if (CNAPI_UUID !== '')
                return (wf$cb(null));

            execFile(ZONENAME, [], function (err, stdout, stderr) {
                if (err)
                    return (wf$cb(err));

                CNAPI_UUID = stdout.trim();
                return (wf$cb(null));
            });
            return (null);
        },

        /* Find URLs for most recent image */
        function (wf$cb) {
            stuffLinks(image, function (err, links) {
                image_file = links.image;
                image_manifest = links.manifest;
                image_pkg = links.pkg;

                return (wf$cb(err));
            });
        },

        /* If package exists, download it */
        function (wf$cb) {
            if (!image_pkg)
                return (wf$cb(null));

            var obj = mod_url.parse(stuffURL(image, image_pkg));
            obj.auth = STUFF_CREDS;
            obj.port = obj.port || 443;

            var pkg = mod_path.join(TMP_DIR, image_pkg);
            var stream = mod_fs.createWriteStream(pkg, { flags: 'w' });

            var req = mod_https.get(obj, function (res) {
                if (res.statusCode !== 200) {
                    self.log.error('stuff(%s) HTTP error: %d',
                        obj.href, res.statusCode);
                    return (wf$cb(new mod_restify.InternalError('cannot ' +
                        'find pkg for %s image', image)));
                }

                res.pipe(stream);

                res.on('error', function (err) {
                    self.log.error('stuff(%s) HTTP request error: %s',
                        obj.href, err.stack);
                    return (wf$cb(err));
                });
                res.on('end', function () {
                    return (wf$cb(null));
                });

                return (null);
            });
            req.on('error', function (err) {
                console.error('stuff(%s) client error: %s',
                    obj.href, err.stack);
                return (wf$cb(err));
            });

            return (null);
        },

        /* If package exists, install it */
        function (wf$cb) {
            if (!image_pkg)
                return (wf$cb(null));

            var pkg = mod_path.join('/zones', CNAPI_UUID,
                '/root/', TMP_DIR, image_pkg);
            var cmd = 'gtar -C /var/tmp/ -xjf ' + pkg;

            return (model.serverInvokeUrScript(server, cmd,
                function (err, stdout, stderr) {
                    return (wf$cb(err));
            }));
        },

        // Transform marlin SMF manifest
        function (wf$cb) {
            if (!image_pkg)
                return (wf$cb(null));

            var root = '/var/tmp/root/opt/smartdc/marlin/';
            var manfile = 'smf/manifests/marlin-agent.xml';

            var cmd = 'sed -e s#@@PREFIX@@#' + root + '#g ' +
                mod_path.join(root, manfile) +
                ' > /var/tmp/marlin-agent.xml';

            return (model.serverInvokeUrScript(server, cmd,
            function (err, stdout, stderr) {
                return (wf$cb(err));
            }));
        },

        // Import marlin SMF manifest
        function (wf$cb) {
            if (!image_pkg)
                return (wf$cb(null));

            var cmd = 'svccfg import /var/tmp/marlin-agent.xml';
            return (model.serverInvokeUrScript(server, cmd,
            function (err, stdout, stderr) {
                if (err)
                    return (wf$cb(err));

                cmd = 'svcadm disable marlin-agent';
                return (model.serverInvokeUrScript(server, cmd,
                function (suberr) {
                    return (wf$cb(suberr));
                }));
            }));
        },

        /* Download image manifest */
        function (wf$cb) {
            var obj = mod_url.parse(stuffURL(image, image_manifest));
            obj.auth = STUFF_CREDS;
            obj.port = obj.port || 443;

            var manifest = mod_path.join(TMP_DIR, image_manifest);
            var stream = mod_fs.createWriteStream(manifest, { flags: 'w' });

            var req = mod_https.get(obj, function (res) {
                if (res.statusCode !== 200) {
                    self.log.error('stuff(%s) HTTP error: %d',
                        obj.href, res.statusCode);
                    return (wf$cb(new mod_restify.InternalError('cannot ' +
                        'find manifest for %s image', image)));
                }

                res.pipe(stream);

                res.on('error', function (err) {
                    self.log.error('stuff(%s) HTTP request error: %s',
                        obj.href, err.stack);
                    return (wf$cb(err));
                });
                res.on('end', function () {
                    return (wf$cb(null));
                });

                return (null);
            });
            req.on('error', function (err) {
                console.error('stuff(%s) client error: %s',
                    obj.href, err.stack);
                return (wf$cb(err));
            });
        },

        /* Parse image manifest to see if already installed */
        function (wf$cb) {
            var manifest = mod_path.join(TMP_DIR, image_manifest);
            mod_fs.readFile(manifest, function (err, contents) {
                if (err)
                    return (wf$cb(err));

                var manifest_uuid = '';
                try {
                    manifest_uuid = JSON.parse(contents).uuid;
                } catch (e) { }
                if (manifest_uuid === '')
                    return (wf$cb(null));

                props.image_uuid = manifest_uuid;

                var cmd = IMGADM + ' info ' + manifest_uuid;

                return (model.serverInvokeUrScript(server, cmd,
                    function (suberr, stdout, stderr) {
                        if (stdout) {
                            var uuid;
                            try {
                                uuid = JSON.parse(stdout).manifest.uuid;
                            } catch (e) { }

                            if (uuid === manifest_uuid) {
                                exists = true;
                                model.log.info(sprintf('image "%s" with ' +
                                    'uuid %s already exists', image, uuid));
                            }
                        }

                        return (wf$cb(null));
                }));
            });
        },

        /* Download image */
        function (wf$cb) {
            if (exists)
                return (wf$cb(null));

            var obj = mod_url.parse(stuffURL(image, image_file));
            obj.auth = STUFF_CREDS;
            obj.port = obj.port || 443;

            var file = mod_path.join(TMP_DIR, image_file);
            var stream = mod_fs.createWriteStream(file, { flags: 'w'});

            var req = mod_https.get(obj, function (res) {
                if (res.statusCode !== 200) {
                    self.log.error('stuff(%s) HTTP error: %d',
                        obj.href, res.statusCode);
                    return (wf$cb(new mod_restify.InternalError('cannot ' +
                        'download image for %s image', image)));
                }

                res.pipe(stream);

                res.on('error', function (err) {
                    self.log.error('stuff(%s) HTTP request error: %s',
                        obj.href, err.stack);
                    return (wf$cb(err));
                });
                res.on('end', function () {
                    return (wf$cb(null));
                });

                return (null);
            });
            req.on('error', function (err) {
                console.error('stuff(%s) client error: %s',
                    obj.href, err.stack);
                return (wf$cb(err));
            });
            return (req);
        },

        /* Install image with imgadm(1m) */
        function (wf$cb) {
            if (exists)
                return (wf$cb(null));

            var dir = mod_path.join('/zones', CNAPI_UUID, '/root/', TMP_DIR);
            var cmd = IMGADM + ' install ' +
                ' -m ' + mod_path.join(dir, image_manifest) +
                ' -f ' + mod_path.join(dir, image_file);

            return (model.serverInvokeUrScript(server, cmd,
                function (err, stdout) {
                    return (wf$cb(err));
            }));
        }
    ], function (err) {
        if (err)
            return (callback(err));
        return (callback(null, props));
    });
}

function downloadAllImages(model, server, callback) {
    var props = {};

    mod_async.forEach(IMAGES, function (image, subcb) {
        downloadAndInstallImage(model, server, image,
        function (err, subprops) {
            props[image] = subprops;
            return (subcb(err));
        });
    }, function (err) {
        return (callback(err, props));
    });
}

/* Update a zone's metadata using vmadm (1m) */
function updateZoneMetadata(model, server, uuid, metadata, callback) {
    var file = mod_path.join(TMP_DIR, '/metadata-' + mod_uuid());

    mod_async.waterfall([
    function (wf$cb) {
        mod_fs.writeFile(file, JSON.stringify(metadata), 'ascii',
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        var propfile = mod_path.join('/zones', CNAPI_UUID, '/root/', file);
        var cmd = VMADM + ' update ' + uuid + ' -f ' + propfile;

        return (model.serverInvokeUrScript(server, cmd, function (err) {
            return (wf$cb(err));
        }));
    },
    function (wf$cb) {
        var cmd = VMADM + ' reboot ' + uuid;

        return (model.serverInvokeUrScript(server, cmd, function (err) {
            return (wf$cb(err));
        }));
    },
    function (wf$cb) {
        return (mod_fs.unlink(file, function (err) {
            return (wf$cb(err));
        }));
    }],
    function (err) {
        return (callback(err));
    });
}

/*
 * Provision an appliance with certain parameters and metadata.
 */
function provisionAppliance(opts, params, metadata, callback) {
    var model = opts.model;
    var server = opts.server;
    var feature = opts.feature;
    var wfapi = model.wfapi;
    var uuid;

    var job = {};
    job.params = feature.params;
    job.params.customer_metadata = metadata;
    job.params.owner_uuid = OWNER_ACCOUNT_UUID;
    job.params.server_uuid = server;
    job.params.image_uuid = opts.appliances[feature.appliance].image_uuid;

    for (var key in COMMON_PARAMS)
        job.params[key] = COMMON_PARAMS[key];
    for (key in params)
        job.params[key] = params[key];

    // XXX Need proper tags in here

    job.config = model.config;

    mod_async.waterfall([
    function (wf$cb) {
        var file = mod_path.join(SCRIPTS_DIR, feature.user_script);

        mod_fs.readFile(file, 'ascii', function (err, script) {
            if (err)
                return (wf$cb(err));

            job.params.customer_metadata['user-script'] = script;
            return (wf$cb(null));
        });
    },
    function (wf$cb) {
        job.params.vm_uuid = uuid = mod_uuid();
        job.params.zonename = job.params.vm_uuid;

        wfapi.createProvisionJob(job, function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        var running = false;
        var retries = 0;

        model.log.info('wait for machine %s to enter running state', uuid);

        mod_async.until(
        function () {
            return (running || retries >= 60);
        },
        function (untilcb) {
            model.loadVm(server, uuid, function (err, details) {
                if (!err && details.state === 'running') {
                    running = true;
                    return (untilcb());
                }

                model.log.info('machine %s not running yet, ' +
                    'waiting one more second (retry %d)', uuid, retries);
                retries++;
                return (setTimeout(untilcb, 1000));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    }],
    function (err) {
        return (callback(err, uuid));
    });
}

function provisionFeature(opts, callback) {
    var model = opts.model;
    var log = model.log;
    var server = opts.server;

    var nameserver_zones = [];
    var nameserver_ips = [];

    // XXX The .joyent.us suffix should probably a parameter
    var dcsuffix = model.config.datacenter + '.joyent.us';

    mod_async.waterfall([
    function (wf$cb) {
        downloadAllImages(model, server, function (err, apps) {
            if (err)
                return (wf$cb(err));

            opts.appliances = apps;
            return (wf$cb(null));
        });
    },
    function (wf$cb) {
        /* Provision 3 DNS/ZK zones */
        mod_async.forEachSeries([0, 1, 2], function (ii, subcb) {
            opts.feature = APPLIANCES.manta_nameservice;

            var params = { alias: 'nameservice' + ii };

            provisionAppliance(opts, params, {}, function (err, uuid) {
                if (err)
                    return (subcb(err));
                nameserver_zones.push(uuid);
                return (subcb(null));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        /* Find IPs of said DNS/ZK zones */
        mod_async.forEachSeries(nameserver_zones, function (uuid, subcb) {
            model.loadVm(server, uuid, function (err, details) {
                if (err)
                    return (subcb(err));

                if (!details.nics || details.nics.length === 0) {
                    log.info('zone %s has no IP address', uuid);
                    return (subcb(null));
                }

                var ip = details.nics[0].ip;
                nameserver_ips.push(ip);
                return (subcb(null));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        /* Update DNS/ZK metadata to use actual IPs */
        var dns = shuffle(nameserver_ips);
        var metadata = {
            set_customer_metadata: {
                nameserver_ips: dns.join(' ')
            }
        };

        mod_async.forEachSeries(nameserver_zones, function (uuid, subcb) {
            updateZoneMetadata(model, server, uuid, metadata, function (err) {
                if (err) {
                    console.log(err);
                    log.error('failed to update nameserver_ips metadata ' +
                        'for zone %s: %s', uuid, err.message);
                }
                return (subcb(err));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        /* 3 indexing shards of 3s manatees each */
        mod_async.forEachSeries([1, 2, 3], function (ii, iicb) {
            mod_async.forEachSeries([1, 2, 3], function (jj, jjcb) {
                opts.feature = APPLIANCES.manta_postgres;
                var metadata = {};

                var svc_name = jj + '.moray.' + dcsuffix;
                metadata['service_name'] = svc_name;
                metadata['service_port'] = 80;

                metadata['MANATEE_REGISTRAR_PATH'] =
                    domainToPath(svc_name) + '/pg';
                metadata['MANATEE_REGISTRAR_PATH_PREFIX'] =
                    domainToPath(svc_name);
                metadata['MANATEE_SHARD_PATH'] = '/shard/' + svc_name;
                metadata['MANATEE_SHARD_ID'] = svc_name;

                // XXX Do I need to shuffle every time?  Either way, lot of dup
                // code
                var dns = shuffle(nameserver_ips);
                metadata['nameservers'] = dns.join(' ');

                var zkUrls = [];
                dns.forEach(function (url) {
                    zkUrls.push(url + ':2181');
                });
                metadata['MANATEE_ZK_URL'] = zkUrls.join(',');

                var params = {
                    alias: 'pg.' + svc_name + '-' + mod_uuid().substr(0, 7)
                };

                provisionAppliance(opts, params, metadata, function (err) {
                    return (jjcb(err));
                });
            },
            function (err) {
                return (iicb(err));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        /* Sleep for 30 seconds to allow ZK registration */
        setTimeout(wf$cb, 30 * 1000);
    },
    function (wf$cb) {
        /* 3 shards of 3 morays each */
        mod_async.forEachSeries([1, 2, 3], function (_, iicb) {
            mod_async.forEachSeries([1, 2, 3], function (jj, jjcb) {
                opts.feature = APPLIANCES.manta_moray;

                var metadata = {};
                var svc_name = jj + '.moray.' + dcsuffix;
                metadata['service_name'] = svc_name;
                metadata['service_port'] = 80;

                var params = {
                    alias: 'moray-' + svc_name + '-' + mod_uuid().substr(0, 7)
                };

                var dns = shuffle(nameserver_ips);
                metadata['nameservers'] = dns.join(' ');

                provisionAppliance(opts, params, metadata, function (err) {
                    return (jjcb(err));
                });
            },
            function (err) {
                return (iicb(err));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        /* 6 loadbalancers, 2 for each shard */
        mod_async.forEachSeries([0, 1], function (_, iicb) {
            mod_async.forEachSeries([1, 2, 3], function (jj, jjcb) {
                opts.feature = APPLIANCES.manta_loadbalancer;

                var metadata = {};

                var dns = shuffle(nameserver_ips);
                metadata['nameservers'] = dns.join(' ');

                var svc_name = jj + '.moray.' + dcsuffix;
                metadata['service_name'] = svc_name;
                metadata['service_port'] = 80;

                var params = {
                    alias: 'lb-' + svc_name + '-' + mod_uuid().substr(0, 7)
                };

                provisionAppliance(opts, params, metadata, function (err) {
                    return (jjcb(err));
                });
            },
            function (err) {
                return (iicb(err));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        /* 6 storage nodes */
        mod_async.forEachSeries([0, 1, 2, 3, 4, 5], function (_, iicb) {
            opts.feature = APPLIANCES.manta_storage;

            var metadata = {};
            var dns = shuffle(nameserver_ips);
            metadata['nameservers'] = dns.join(' ');

            metadata['domain_name'] = 'stor.' + dcsuffix;
            metadata['moray_url'] = '1.moray.' + dcsuffix;

            var params = {
                alias: 'storage.' + metadata['domain_name'] + '-' +
                    mod_uuid().substr(0, 7)
            };

            provisionAppliance(opts, params, metadata, function (err) {
                return (iicb(err));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        /* 1 jobwoker (marlin zone) */
        opts.feature = APPLIANCES.manta_jobworker;

        var metadata = {};
        var dns = shuffle(nameserver_ips);
        metadata['nameservers'] = dns.join(' ');

        metadata['domain_name'] = 'marlin.' + dcsuffix;
        metadata['moray_storage_name'] = '1.moray.' + dcsuffix;

        var indexers = [
            '1.moray.' + dcsuffix,
            '2.moray.' + dcsuffix,
            '3.moray.' + dcsuffix].join(' ');
        metadata['moray_indexer_names'] = indexers;

        var params = {
            alias: 'jobworker.' + metadata['domain_name'] + '-' +
                mod_uuid().substr(0, 7)
        };

        provisionAppliance(opts, params, metadata, function (err) {
            if (err)
                return (wf$cb(err));

            var svc_name = 'manta.' + dcsuffix;
            var moray = '1.moray.' + dcsuffix;

            var cmd = '/var/tmp/root/opt/smartdc/marlin/tools/mragentconf ' +
                server + ' ' + svc_name + ' ' + moray + ' ' + dns.join(' ');

            return (model.serverInvokeUrScript(server, cmd, function (suberr) {
                return (wf$cb(suberr));
            }));
        });
    },
    function (wf$cb) {
        /* 3 WebAPIs */
        mod_async.forEachSeries([1, 2, 3], function (ii, iicb) {
            opts.feature = APPLIANCES.manta_webapi;
            var metadata = {};

            var dns = shuffle(nameserver_ips);
            metadata['nameservers'] = dns.join(' ');

            metadata['domain_name'] = 'manta.' + dcsuffix;
            metadata['moray_storage_name'] = '1.moray.' + dcsuffix;

            var indexers = [
                '1.moray.' + dcsuffix,
                '2.moray.' + dcsuffix,
                '3.moray.' + dcsuffix].join(' ');

            metadata['moray_indexer_names'] = indexers;

            var params = {
                alias: 'webapi-' + metadata['domain_name'] + '-' +
                    mod_uuid().substr(0, 7)
            };

            provisionAppliance(opts, params, metadata, function (err) {
                return (iicb(err));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    },
    function (wf$cb) {
        /* 2 LBs */
        mod_async.forEachSeries([0, 1], function (ii, iicb) {
            opts.feature = APPLIANCES.manta_loadbalancer;

            var metadata = {};

            var dns = shuffle(nameserver_ips);
            metadata['nameservers'] = dns.join(' ');

            var svc_name = 'manta.' + dcsuffix;
            metadata['service_name'] = svc_name;
            metadata['service_port'] = 80;

            var params = {
                alias: 'lb-' + svc_name + '-' + mod_uuid().substr(0, 7)
            };

            provisionAppliance(opts, params, metadata, function (err) {
                return (iicb(err));
            });
        },
        function (err) {
            return (wf$cb(err));
        });
    }],
    function (err) {
        return (callback(err));
    });
}


function Feature() { }


Feature.list = function (req, res, next) {
    var features = [ 'manta' ];
    res.send(features);
    return (next());
};


Feature.provisionManta = function (req, res, next) {
    var opts = {
        model: this.model,
        server: req.params.server_uuid
    };

    provisionFeature(opts, function (err) {
        if (err) {
            console.log(err);
            res.send(500);
            return (next());
        }

        res.send('OK');
        return (next());
    });
};


function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // List server features
    http.get(
        { path: '/features', name: 'ListFeatures' },
        Feature.list.bind(toModel));

    // Provision manta
    http.post(
        { path: '/provision/manta/:server_uuid', name: 'ProvisionManta' },
        Feature.provisionManta.bind(toModel));

    // Pseudo-W3C (not quite) logging.
    http.on('after', function (req, res, name) {
        model.log.info('[%s] %s "%s %s" (%s)', new Date(), res.statusCode,
        req.method, req.url, name);
    });
}

exports.attachTo = attachTo;
