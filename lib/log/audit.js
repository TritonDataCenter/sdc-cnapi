var bunyan = require('bunyan');

// Based on the amon audit logger
function auditLogger(options) {
    var log = options.log.child({
        audit: true,
        serializers: {
            err: bunyan.stdSerializers.err,
            req: function auditRequestSerializer(req) {
                if (!req) {
                    return false;
                }

                return {
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    httpVersion: req.httpVersion,
                    version: req.version,
                    body: options.body === true ? req.body : undefined
                };
            },
            res: function auditResponseSerializer(res) {
                if (!res) {
                   return false;
                }

                return {
                    statusCode: res.statusCode,
                       headers: res._headers,
                       body: options.body === true ? res._body : undefined
                };
            }
        }
    });

    function audit(req, res, route, err) {
        // Skip logging some high frequency endpoints to key log noise down.
        var method = req.method;
        var path = req.path();
        var obj;
        var latency;
        var show;

        // Tune down some noisy logging
        if (path === '/ping' && method === 'GET') {
            obj = undefined;
        } else if (path.match(
            /^\/servers\/[^\/]+\/vms\/[^\/]+/g) && method === 'GET')
        {
            // Exclude /servers/:serveruuid/vms/:vmsuuid from logging by default
            obj = undefined;
        } else if (
            path.match(/^\/servers/g) && method === 'GET' ||
            path.match(/^\/servers\/[^\/]+/g) && method === 'GET')
        {
            show = false;
            latency = res.getHeader('Response-Time');
            if (typeof (latency) !== 'number') {
                latency = Date.now() - req.time();
            }
            obj = {
                remoteAddress: req.connection.remoteAddress,
                remotePort: req.connection.remotePort,
                req_id: req.getId(),
                req: req,
                // res: res,
                err: err,
                latency: latency
            };
        } else {
            show = true;
            latency = res.getHeader('Response-Time');
            if (typeof (latency) !== 'number') {
                latency = Date.now() - req.time();
            }

            obj = {
                remoteAddress: req.connection.remoteAddress,
                remotePort: req.connection.remotePort,
                req_id: req.getId(),
                req: req,
                res: res,
                err: err,
                latency: latency
            };
        }

        if (show) {
            log.info(
                obj, '%s handled "%s %s": %d',
                (route ? route + ' ' : ''), method, path, res.statusCode);
        } else {
            log.info(
                '%s handled "%s %s": %d',
                (route ? route + ' ' : ''), method, path, res.statusCode);
        }

        return true;
    }

    return audit;
}

module.exports = {
    auditLogger: auditLogger
};
