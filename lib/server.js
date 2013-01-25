var restify = require('restify');
var restifyValidator = require('restify-validator');

var endpoints = require('./endpoints/index');

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
    cnapi.on('after', restify.auditLogger({log: cnapi.log, body: true}));
    cnapi.use(restifyValidator);

    endpoints.attachTo(cnapi, options.model);

    return cnapi;
}

exports.createServer = createServer;
