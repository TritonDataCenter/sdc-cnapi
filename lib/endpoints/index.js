var servers = require('./servers');

exports.attachTo = function (http, model) {
    servers.attachTo(http, model);
}
