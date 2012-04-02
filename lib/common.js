var fs = require('fs');

function loadConfig(filename, callback) {
    fs.readFile(filename, function (error, data) {
        return callback(error, JSON.parse(data.toString()));
    });
}

exports.loadConfig = loadConfig;
