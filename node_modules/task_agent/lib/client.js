// send a command to:
//   $resource.request.$command.$uuid

var amqp   = require('./amqp-plus');
var common = require('./common');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

var Client = module.exports = function (config) {
  this.config = config = config || { amqp: {} };
  this.commandTimeout = config.timeout || 5000;
  this.config.reconnect = config.reconnect || false;
  this.verbose = config.verbose;
}

Client.prototype.configureAMQP = common.configureAMQP;

Client.prototype.connect = function(callback) {
  var self = this;

  this.connection = amqp.createConnection(this.config.amqp);

  // Set up the exchange we'll be using to publish our commands. We wait for the
  // exchange to open and then run the callback.
  this.connection.addListener('ready', self.onConnect.bind(self));
}

Client.prototype.useConnection = function (connection) {
  var self = this;
  self.connection = connection;
  self.connection.on('ready', self.onConnect.bind(self));
}

Client.prototype.onConnect = function () {
    var self = this;
    self.agentHandles = {};
    self.exchange = self.connection.exchange('amq.topic', { type: 'topic' });
};

Client.prototype.end = function () {
  this.config.reconnect = false;
  this.connection.end();
}

/**
 * The "Client" object is decoupled from the creation and management of queues
 * used to communicate with the agents. We will have the Client object hand us
 * handles/closures/whatever that will deal with their own objects.
 */

Client.prototype.getAgentHandle = function (resource, uuid, callback) {
  var handle;

  if (!this.agentHandles) {
    this.agentHandles = {};
  }

  if (this.agentHandles[uuid]) {
    handle = this.agentHandles[uuid];
    return callback(handle);
  }
  else {
    handle = this.agentHandles[uuid]
      = new AgentHandle
          ( { connection: this.connection
            , exchange:   this.exchange
            , uuid:       uuid
            , timeout:    this.commandTimeout
            , resource:   resource
            }
          );
    handle.prepareAgentEventQueue(function () {
      callback(handle);
    });
  }
}

var AgentHandle = function (args) {
  this.uuid = args.uuid;
  this.connection = args.connection;
  this.exchange = args.exchange;
  this.clientId = common.genId();
  this.resource = args.resource;
  this.commandTimeout = args.timeout;
  this.taskHandles = {};
}

AgentHandle.prototype.prepareAgentEventQueue = function (callback) {
  var self = this;

  var queueName = common.dotjoin(this.resource + '-client', this.uuid, 'events', common.genId());

  console.warn('Waiting for task events on queue: ' + queueName);
  
  var queue = this.connection.queue(queueName, { autoDelete: true }, queueCallback);

  function queueCallback() {
    var rk = common.dotjoin(self.resource, '*', 'event', '*', self.clientId, '*');

    console.warn("Binding to: " + rk);
    queue.bind('amq.topic', rk);

    queue.subscribe(function (msg, headers, deliveryInfo) {
      var rkParts = deliveryInfo.routingKey.split('.');
      var eventType = rkParts[3];
      var taskId = rkParts[5];
      if (self.taskHandles[taskId]) {
        self.taskHandles[taskId].emit('event', eventType, msg);
      }
    });
    callback();
  }
}

function TaskHandle (id) {
  EventEmitter.call(this);
  this.id = id;
}

util.inherits(TaskHandle, EventEmitter);

AgentHandle.prototype.sendTask = function (task, msg, callback) {
  var self = this;

  msg.task_id   = common.genId(); 
  msg.client_id = self.clientId;

  var taskHandle = this.taskHandles[msg.task_id] = new TaskHandle(msg.task_id);

  var routingKey = common.dotjoin(this.resource, this.uuid, 'task', task);

  console.warn("Publishing message to routing key: '" + routingKey + "'");
  console.warn(JSON.stringify(msg, null, '  '));
  self.exchange.publish(routingKey, msg);
  callback(taskHandle);
}
