var os = require('os');
var restify = require('restify');
var restifyValidator = require('restify-validator');
var audit_logger = require('./log/audit');

var endpoints = require('./endpoints/index');

function createServer(options) {
    var cnapi = restify.createServer({
        name: 'Compute Node API',
        log: options.log
    });

    cnapi.use(restify.requestLogger());
    cnapi.use(restify.acceptParser(cnapi.acceptable));
    cnapi.use(restify.authorizationParser());
    cnapi.use(restify.dateParser());
    cnapi.use(restify.queryParser());
    cnapi.use(restify.bodyParser());
    cnapi.use(restifyValidator);

    cnapi.on('after', function (req, res, route, err) {
        var method = req.method;
        var path = req.path();
        if (method === 'GET' || method === 'HEAD') {
            if (path === '/ping') {
                return;
            }
        }
        // Successful GET res bodies are uninteresting and *big*.
        var body = method !== 'GET' &&
                   res.statusCode !== 404 &&
                   Math.floor(res.statusCode/100) !== 2;

        restify.auditLogger({
            log: req.log.child({ route: route }, true),
            body: body
        })(req, res, route, err);
    });

    cnapi.use(function (req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', cnapi.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });
        next();
    });

    cnapi.on('uncaughtException', function (req, res, route, err) {
        req.log.error(err);
        res.send(err);
    });

    endpoints.attachTo(cnapi, options.app);

    return cnapi;
}

exports.createServer = createServer;
