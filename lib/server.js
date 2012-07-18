var restify = require('restify');
var endpoints = require('./endpoints');

function createServer(options) {
    var cnapi = restify.createServer({
        name: 'Compute Node API',
        log: options.log
    });

    cnapi.use(restify.acceptParser(cnapi.acceptable));
    cnapi.use(restify.authorizationParser());
    cnapi.use(restify.dateParser());
    cnapi.use(restify.queryParser());
    cnapi.use(restify.bodyParser());
    cnapi.on('after', restify.auditLogger({log: cnapi.log}));

    var model = options.model;

    endpoints.attachTo(cnapi, model);
    return cnapi;
}

exports.createServer = createServer;
