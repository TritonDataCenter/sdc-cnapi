/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Workflow client wrapper.
 */

var WorkflowClient = require('wf-client');

function Workflow(options) {
    this.log = options.log;
    this.config = options.config;
    this.connected = false;
}


Workflow.prototype.getClient = function (callback) {
    if (!this.client) {
        this.client = new WorkflowClient(this.config);
    }
    return this.client;
};


Workflow.prototype.startAvailabilityWatcher = function () {
    var self = this;

    setInterval(function () {
        pingWorkflow();
    }, 10000);

    function pingWorkflow() {
        var client = self.getClient();

        // Try to get a fake workflow, check the error code if any.
        client.ping(function (error) {
            if (error) {
                if (self.connected) {
                    self.log.error('Workflow appears to be unavailable');
                }

                if (error.syscall === 'connect') {
                    self.connected = false;
                    self.log.error(
                        'Failed to connect to Workflow API (%s)', error.code);
                    return;
                }

                self.connected = false;
                self.log.error({ error: error }, 'Ping failed');

                return;
            }

            if (!self.connected) {
                client.getWorkflow(
                    'workflow-check',
                    function (err, val) {
                        if (err.statusCode !== 404)
                        {
                            self.log.warn(err,
                                'Workflow API Error: %d',
                                err.statusCode);
                            return;
                        }
                        if (!self.connected) {
                            self.connected = true;
                            self.log.info('Connected to Workflow API.');
                        }
                    });
            }
        });
    }

    pingWorkflow();
};


module.exports = Workflow;
