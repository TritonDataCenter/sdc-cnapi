var restify = require('restify');
var endpoints = require('./endpoints');

function createServer(model) {
    var cnapi = restify.createServer({
        name: 'Compute Node API'
    });

    endpoints.attachTo(cnapi, model);
    return cnapi;
}

exports.createServer = createServer;
