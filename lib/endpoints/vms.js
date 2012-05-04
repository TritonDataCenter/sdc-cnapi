var wfapi = require('../wfapi');

function VM() {}

function createProvisionerEventHandler(jobuuid) {
    var wfclient = wfapi.getClient();

    return function (taskid, event) {
        if (!jobuuid) {
            return;
        }

        wfclient.log.info(
            'Posting task info (task %s) to workflow jobs endpoint (job %s)',
            taskid, jobuuid);
        wfclient.client.post(
            '/jobs/' + jobuuid + '/info',
            { mesage: event },
            function (error, req, res, obj) {
                if (error) {
                    wfclient.log.error(
                        error, 'Error posting info to jobs endpoint');
                    return;
                }
                wfclient.log.info(
                    'Posted task info (task %s, job %s)',
                    taskid, jobuuid);
            });
    };
}

function createTaskCallback(req, res, next) {
    return function (error, task_id) {
        res.send({ id: task_id });
        return next();
    };
}

VM.load = function (req, res, next) {
    var self = this;
    self.model.loadVm(
        req.params.server_uuid,
        req.params.uuid,
        function (error, vm) {
            res.send(vm);
            return next();
        });
};

VM.start = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_boot',
        req.params,
        createProvisionerEventHandler(req.params.jobid),
        createTaskCallback(req, res, next));
};

VM.stop = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_shutdown',
        req.params,
        createProvisionerEventHandler(req.params.jobid),
        createTaskCallback(req, res, next));
};

VM.reboot = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_reboot',
        req.params,
        createProvisionerEventHandler(req.params.jobid),
        createTaskCallback(req, res, next));
};

VM.nop = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'nop',
        req.params,
        createProvisionerEventHandler(req.params.jobid),
        createTaskCallback(req, res, next));
};

VM.create = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_create',
        req.params,
        createProvisionerEventHandler(req.params.jobid),
        createTaskCallback(req, res, next));
};

VM.destroy = function (req, res, next) {
    var self = this;
    self.model.sendProvisionerTask(
        req.params.server_uuid,
        'machine_destroy',
        req.params,
        createProvisionerEventHandler(req.params.jobid),
        createTaskCallback(req, res, next));
};

function attachTo(http, model) {
    var toModel = {
        model: model
    };

    // Create VM
    http.post(
        { path: '/servers/:server_uuid/vms', name: 'CreateVm' },
        VM.create.bind(toModel));

    // Load VM's properties from the server
    http.get(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'LoadVm' },
        VM.load.bind(toModel));

    // Start VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/start', name: 'StartVm' },
        VM.start.bind(toModel));

    // Stop VM
    http.post(
        { path: '/servers/:server_uuid/vms/:uuid/stop', name: 'StopVm' },
        VM.stop.bind(toModel));

    // Reboot VM
    http.post(
       { path: '/servers/:server_uuid/vms/:uuid/reboot', name: 'RebootVm' },
        VM.reboot.bind(toModel));

    // Delete a VM
    http.del(
        { path: '/servers/:server_uuid/vms/:uuid', name: 'DestroyVm' },
        VM.destroy.bind(toModel));

    // No-op task
    http.get(
        { path: '/servers/:server_uuid/nop', name: 'DoNop' },
        VM.nop.bind(toModel));

}

exports.attachTo = attachTo;
