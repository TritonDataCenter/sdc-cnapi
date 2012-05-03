var servers = require('./servers');
var vms = require('./vms');
var tasks = require('./tasks');

exports.attachTo = function (http, model) {
    http.post(
        '/loglevel',
        function (req, res, next) {
            var level = req.params.level;
            model.log.debug('Setting loglevel to %s', level);
            model.log.level(level);
            res.send();
            return next();
        });

    http.get(
        '/loglevel',
        function (req, res, next) {
            res.send({ level: model.log.level() });
            return next();
        });

    servers.attachTo(http, model);
    vms.attachTo(http, model);
    tasks.attachTo(http, model);
};
