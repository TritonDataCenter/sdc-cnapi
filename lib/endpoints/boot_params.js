function BootParams() {}

BootParams.getDefault = function (req, res, next) {
    var self = this;
    self.model.getBootParamsDefault(
        function (error, params) {
            res.send(params);
            return next();
        });
};

BootParams.getByUuid = function (req, res, next) {
    var self = this;
    self.model.getBootParamsByUuid(
        req.params.uuid,
        function (error, params) {
            res.send(params);
            return next();
        });
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // Return the default boot parameters (for any server)
    http.get(
        { path: '/boot/default', name: 'GetDefaultBootParams' },
        BootParams.getDefault.bind(toModel));

    // Return the boot parameters for a particular server
    http.get(
        { path: '/boot/:uuid', name: 'GetBootParams' },
        BootParams.getByUuid.bind(toModel));
}

exports.attachTo = attachTo;
