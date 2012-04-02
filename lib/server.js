var restify = require('restify');
var endpoints = require('./endpoints');

function createServer(options) {
    var cnapi = restify.createServer({
        name: 'Compute Node API'
    });

    cnapi.use(restify.acceptParser(cnapi.acceptable));
    cnapi.use(restify.authorizationParser());
    cnapi.use(restify.dateParser());
    cnapi.use(restify.queryParser());
    cnapi.use(restify.bodyParser());

    var model = options.model;

    endpoints.attachTo(cnapi, model);
    return cnapi;
}

exports.createServer = createServer;
