var boot_params = require('./boot_params');
var platforms = require('./platforms');
var servers = require('./servers');
var tasks = require('./tasks');
var ur = require('./ur');
var vms = require('./vms');
var zfs = require('./zfs');

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

    platforms.attachTo(http, model);
    servers.attachTo(http, model);
    vms.attachTo(http, model);
    tasks.attachTo(http, model);
    boot_params.attachTo(http, model);
    ur.attachTo(http, model);
    zfs.attachTo(http, model);
};
