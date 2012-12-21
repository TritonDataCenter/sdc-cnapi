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


Workflow.prototype.startAvailabilityWatcher = function (callback) {
    var self = this;
    var connectionTimeout;

    function pingWorkflow() {
        connectionTimeout = setTimeout(function () {
            pingWorkflow();
        }, 10000);

        // Try to get a fake workflow, check the error code if any.
        self.getClient().ping(function (error) {
            if (error) {
                if (self.connected) {
                    self.log.error('Workflow appears to be unavailable');
                }

                if (error.syscall === 'connect') {
                    clearTimeout(connectionTimeout);
                    self.connected = false;
                    self.log.error(
                        'Failed to connect to Workflow API (%s)', error.code);
                    process.nextTick(function () {
                        pingWorkflow();
                    });
                    return;
                }

                clearTimeout(connectionTimeout);
                self.connected = false;
                self.log.error({ error: error }, 'Ping failed');
                process.nextTick(function () {
                    pingWorkflow();
                });

                return;
            }

            if (!self.connected) {
                self.connected = true;
                self.log.info('Connected to Workflow API.');
            }
        });
    }

    pingWorkflow();
};


module.exports = Workflow;
