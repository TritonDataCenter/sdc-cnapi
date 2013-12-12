var fs = require('fs');
var uuid = require('node-uuid');

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


module.exports = {
    genId: genId,
    loadConfig: loadConfig,
    timestamp: timestamp,
    isString: isString,
    filterEscape: filterEscape
};
