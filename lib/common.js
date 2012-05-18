var fs = require('fs');

function loadConfig(filename, callback) {
    fs.readFile(filename, function (error, data) {
        return callback(error, JSON.parse(data.toString()));
    });
}

function timestamp() {
    return (
        new Date()).toISOString().replace(/[:-]/g, '').replace(/\.\d+Z/, 'Z');
}

exports.loadConfig = loadConfig;
exports.timestamp = timestamp;
