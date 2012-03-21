var restify = require('restify');
var endpoints = require('./endpoints');

function createServer(serverOptions) {
    var cnapi = restify.createServer({
        name: 'Compute Node API'
    });

    var model = serverOptions.model;

    endpoints.attachTo(cnapi, model);
    return cnapi;
}

exports.createServer = createServer;
