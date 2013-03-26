var restify = require('restify');
var restifyValidator = require('restify-validator');
var audit_logger = require('./log/audit');

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
    cnapi.use(restifyValidator);
    cnapi.on('after', audit_logger.auditLogger({
        log: cnapi.log,
        body: true
    }));

    cnapi.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });

    endpoints.attachTo(cnapi, options.app);

    return cnapi;
}

exports.createServer = createServer;
