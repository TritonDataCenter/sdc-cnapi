var fs = require('fs');
var uuid = require('node-uuid');
var qs = require('querystring');

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
    return uuid.v4();
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


module.exports = {
    genId: genId,
    loadConfig: loadConfig,
    timestamp: timestamp,
    isString: isString,
    filterEscape: filterEscape,
    orderedKVString: orderedKVString
};
