var fs = require('fs');
var uuid = require('node-uuid');

function loadConfig(filename, callback) {
    fs.readFile(filename, function (error, data) {
        return callback(error, JSON.parse(data.toString()));
    });
}

function timestamp() {
    return (
        new Date()).toISOString().replace(/[:-]/g, '').replace(/\.\d+Z/, 'Z');
}

function genId() {
    return uuid.v4();
}

exports.genId = genId;
exports.loadConfig = loadConfig;
exports.timestamp = timestamp;
