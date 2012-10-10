var fs = require('fs');
var uuid = require('node-uuid');

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
    isString: isString

};
