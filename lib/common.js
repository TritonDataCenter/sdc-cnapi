/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var fs = require('fs');
var libuuid = require('libuuid');

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
    loadConfig: loadConfig,
    timestamp: timestamp,
    isString: isString,
    filterEscape: filterEscape,
    randSort: randSort,
    HEARTBEAT_RECONCILIATION_PERIOD_SECONDS:
        HEARTBEAT_RECONCILIATION_PERIOD_SECONDS,
    HEARTBEAT_LIFETIME_SECONDS: HEARTBEAT_LIFETIME_SECONDS
};
