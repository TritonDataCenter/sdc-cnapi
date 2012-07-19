var assert = require('assert');
var restify = require('restify');

var WORKFLOW_PATH = './workflows/';

function Wfapi(config) {
    this.client = restify.createJsonClient({
        url: config.wfapi.url,
        username: config.wfapi.username,
        password: config.wfapi.password,
        version: '*'
    });

    this.log = config.log;

    this.workflows = config.wfapi.workflows || [];
    this.uuids = {};
}

Wfapi.prototype.getClient = function () {
    return (this.client);
};

/*
 * Intializes all workflows provided by CNAPI.
 */
Wfapi.prototype.initWorkflows = function () {
    var self = this;

    self.workflows.forEach(function (wf) {
        self.getWorkflow(wf, function (err, auuid) {
            if (err)
                self.log.error('Error getting workflow "' + wf + '"', err);

            if (auuid) {
                self.log.debug('Workflow "' + wf + '" exists');
                self.uuids[wf] = auuid;
            } else {
                self.log.debug('"' + wf + '" workflow doesn\'t exist, ' +
                               'let\'s create it');
                self.createWorkflow(wf, function (aerr, buuid) {
                    if (aerr)
                        self.log.error('Could not find "' + wf +
                                       '" workflow', aerr);
                    else
                        self.uuids[wf] = buuid;
                });
            }
        });
    });
};

/*
 * Retrieves a workflow from WFAPI.
 */
Wfapi.prototype.getWorkflow = function (name, cb) {
    this.client.get('/workflows', function (err, req, res, wfs) {
        if (err)
            return cb(err);

        if (!wfs.length)
            return cb(null, null);

        for (var i = 0; i < wfs.length; i++) {
            var wf = wfs[i];

            if (wf.name.indexOf(name) != -1)
                return cb(null, wf.uuid);
        }

        return cb(null, null);
    });
};

/*
 * Creates a workflow on WFAPI. Currently only works with a provision workflow,
 * which means that the function doesn't take any workflow as an argument yet
 */
Wfapi.prototype.createWorkflow = function (name, cb) {
    var self = this;
    var file = require(WORKFLOW_PATH + name);

    var serialized = self.serializeWorkflow(file);

    self.client.post('/workflows', serialized, function (err, req, res, wf) {
        if (err)
            return cb(err);

        return cb(null, wf.uuid);
    });
};

/*
 * Serializes a workflow object. This function is basically converting object
 * properties that are functions into strings, so they can be properly
 * represented as JSON
 */
Wfapi.prototype.serializeWorkflow = function (wf) {
    var i;

    if (wf.chain.length) {
        for (i = 0; i < wf.chain.length; i++) {
            if (wf.chain[i].body)
                wf.chain[i].body = wf.chain[i].body.toString();

            if (wf.chain[i].fallback)
                wf.chain[i].fallback = wf.chain[i].fallback.toString();
        }
    }


    if (wf.onerror.length) {
        for (i = 0; i < wf.onerror.length; i++) {
            if (wf.onerror[i].body)
                wf.onerror[i].body = wf.onerror[i].body.toString();
      }
    }

    return wf;
};

/*
 * Queues a provision job.
 */
Wfapi.prototype.createProvisionJob = function (req, cb) {
    var job = req.params;

    job.task = 'provision';
    job.target = '/provision-' + job.vm_uuid;
    job.workflow = this.uuids['provision-cnapi'];
    job.expects = 'running';

    job['ufds_url'] = req.config.ufds.url;
    job['ufds_dn'] = req.config.ufds.bindDN;
    job['ufds_password'] = req.config.ufds.bindPassword;

    job['napi_url'] = req.config.napi.url;
    job['napi_username'] = req.config.napi.username;
    job['napi_password'] = req.config.napi.password;

    job['cnapi_url'] = req.config.cnapi.url;
    job['vmapi_url'] = req.config.vmapi.url;
    job['dapi_url'] = req.config.dapi.url;

    console.log(job);

    this.log.info('Submitting job to provision %s', job.vm_uuid);

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        return cb(null, job.vm_uuid, theJob.uuid);
    });
};

module.exports = Wfapi;
