var async = require('async');
var restify = require('restify');

var client;
var log;

function WorkflowApi() {}

function initializeClient(config) {
    client = restify.createJsonClient({
        url: config.wfapi.url,
        username: config.wfapi.username,
        password: config.wfapi.password,
        version: '*'
    });

    log = config.log;
}

function getClient() {
    return client;
}

exports.WorkflowApi = WorkflowApi;
exports.initializeClient = initializeClient;
exports.getClient = getClient;
