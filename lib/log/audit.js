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

        if (path == '/ping' && method == 'GET') {
            return undefined;
        }

        var latency = res.getHeader('Response-Time');
        if (typeof (latency) !== 'number') {
            latency = Date.now() - req.time();
        }

        var obj = {
            remoteAddress: req.connection.remoteAddress,
            remotePort: req.connection.remotePort,
            req_id: req.getId(),
            req: req,
            res: res,
            err: err,
            latency: latency
        };

        log.info(
            obj, '%s handled: %d', (route ? route + ' ' : ''), res.statusCode);

        return true;
    }

    return audit;
}

module.exports = {
    auditLogger: auditLogger
};
