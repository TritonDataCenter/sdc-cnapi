/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var fs = require('fs');
var libuuid = require('libuuid');
var qs = require('querystring');


var HEARTBEAT_RECONCILIATION_PERIOD_SECONDS = 5;

/*
 * Number of seconds before we consider a heartbeat stale.
 * Currently cn-agent is set to push this data every 5 seconds. So we allow for
 * one failure and a 1 second delay by setting the lifetime to 11 seconds.
 */
var HEARTBEAT_LIFETIME_SECONDS = 11;

/**
 * RFC 2254 Escaping of filter strings
 * @author [Austin King](https://github.com/ozten)
 */

function filterEscape(inp) {
    if (typeof (inp) === 'string') {
        var esc = '';
        for (var i = 0; i < inp.length; i++) {
            switch (inp[i]) {
                case '*':
                    esc += '\\2a';
                    break;
                case '(':
                    esc += '\\28';
                    break;
                case ')':
                    esc += '\\29';
                    break;
                case '\\':
                    esc += '\\5c';
                    break;
                case '\0':
                    esc += '\\00';
                    break;
                default:
                    esc += inp[i];
                    break;
            }
        }

        return esc;
    } else {
        return inp;
    }
}


function loadConfig(filename, callback) {
    fs.readFile(filename, function (error, data) {
        if (error) {
            callback(error);
            return;
        }
        callback(error, JSON.parse(data.toString()));
        return;
    });
}


function timestamp() {
    return (
        new Date()).toISOString().replace(/[:-]/g, '').replace(/\.\d+Z/, 'Z');
}


function genId() {
    return libuuid.create();
}


function isString(obj) {
    return Object.prototype.toString.call(obj) === '[object String]';
}

// Return a query string representation of a "flat" (un-nested) object such
// that that the keys in the query string appear in sorted order. This makes
// it possible to compare two objects for equality using a string comparison.
//
// Convert from:
//      {
//           b: 10,
//           x: "hi",
//           a: 3.0
//      }
//
// To:
//      a=3.0&b=10&x=hi

function orderedKVString(obj) {
    var keys = Object.keys(obj).sort();
    var parts = [];
    var i = keys.length;
    while (i--) {
        parts.unshift(qs.escape(keys[i]) + '=' + qs.escape(obj[keys[i]]));
    }
    return parts.join('&');
}


function getAdminIp(sysinfo) {
    var interfaces;
    var ip;
    var admin_tag = 'admin';

    if (sysinfo['Admin NIC Tag']) {
        admin_tag = sysinfo['Admin NIC Tag'];
    }

    interfaces = sysinfo['Network Interfaces'];

    for (var iface in interfaces) {
        if (!interfaces.hasOwnProperty(iface)) {
            continue;
        }

        var nic = interfaces[iface]['NIC Names'];
        var isAdmin = nic.indexOf(admin_tag) !== -1;
        if (isAdmin) {
            ip = interfaces[iface]['ip4addr'];
            return ip;
        }
    }

    return ip;
}

// Take an array and sort it randomly.

function randSort(array) {
    /* Durstenfeld shuffle */
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));

        var tmp = array[i];
        array[i] = array[j];
        array[j] = tmp;
    }

    return array;
}


module.exports = {
    genId: genId,
    getAdminIp: getAdminIp,
    loadConfig: loadConfig,
    timestamp: timestamp,
    isString: isString,
    filterEscape: filterEscape,
    randSort: randSort,
    orderedKVString: orderedKVString,
    HEARTBEAT_RECONCILIATION_PERIOD_SECONDS:
        HEARTBEAT_RECONCILIATION_PERIOD_SECONDS,
    HEARTBEAT_LIFETIME_SECONDS: HEARTBEAT_LIFETIME_SECONDS
};
