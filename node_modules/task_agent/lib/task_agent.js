var util           = require('util')
  , path           = require('path')
  , Agent          = require('./agent')
  , ThrottledQueue = require('./throttled_queue')
  , common         = require('./common')
  , TaskRunner     = require('./task_runner')

var TaskAgent = module.exports = function (config) {
  Agent.call(this, config);
  if (!config.resource) {
    throw new Error("configuration parameter 'resource' must be specified");
  }

  this.log4js = config.log4js;
  this.log = config.log4js.getLogger('agent');

  if (config.tasksPath) {
    this.tasksPath = config.tasksPath;
  }
  else {
    this.log.warn("Warning: no taskPaths specified when instantiating TaskAgent");
    this.tasksPath = path.join(__dirname, '..', 'tasks');
  }
  this.resource = config.resource;
  this.runner
    = new TaskRunner({ tasksPath: this.tasksPath, log4js: config.log4js});
}

util.inherits(TaskAgent, Agent);

TaskAgent.prototype.useQueues = function (defns) {
  var self = this;

  defns.forEach(function (queueDefn) {
    var routingKeys
      = queueDefn.tasks.map(function (t) {
          return [ self.resource
                 , self.uuid
                 , 'task'
                 , t
                 ].join('.');
      
        });

    var queueName = [self.resource, self.uuid, queueDefn.name].join('.');
    var queue;
    
    var callback = function (msg, headers, deliveryInfo) {
      var rkParts = deliveryInfo.routingKey.split('.');

      self.log.info("Incoming routing key was: ");
      self.log.info(util.inspect(rkParts, true, 10));
      self.log.info("Incoming message was: ");
      self.log.info(util.inspect(msg, true, 10));

      var task     = rkParts[3];
      var clientId = msg.client_id;
      var taskId   = msg.task_id;

      var request
        = { finish:    finish
          , task:      task
          , params:    msg
          , event:     event
          , progress:  progress
          };

      queueDefn.onmsg(request);

      function finish () {
        queue.complete();
      }

      function progress (value) {
        event('progress', { value: value });
      }

      function event (name, msg) {
        var rk = common.dotjoin
                   ( self.resource
                   , self.uuid
                   , 'event'
                   , name
                   , clientId
                   , taskId
                   );

        self.log.info("Publishing event to routing key (" + rk + "):");
        self.log.debug(util.inspect(msg, true, 10));
        self.exchange.publish(rk, msg);
      }
    };

    self.log.info("Binding to queue (" + queueName + ") routing keys: ");
    self.log.debug(util.inspect(routingKeys, true, 10));

    var queueOptions
      = { connection:  self.connection
        , queueName:   queueName
        , routingKeys: routingKeys
        , callback:    callback
        , maximum:     queueDefn.maxConcurrent
        };
    queue = new ThrottledQueue(queueOptions);
    queue.next();
  });
}

TaskAgent.prototype.setupPingQueue = function (taskQueues) {
  var self = this;
  var queueName = this.resource + '.ping.' + this.uuid;
  var queue = this.connection.queue(queueName);

  queue.addListener('open', function (messageCount, consumerCount) {
    queue.bind
      ( 'amq.topic'
      , self.resource + '.ping.' + self.uuid
      );
    queue.subscribe({ ack: true }, function (msg, headers, deliveryInfo) {
      self.log.info("Received ping message");
      var client_id = msg.client_id;
      var id = msg.id;

      var msg = { req_id: id
                , timestamp: new Date().toISOString()
                };
      var routingKey
        = self.resource
          + '.ack'
          + client_id
          + '.'
          + self.uuid;


      self.log.info("Publishing ping reply to " + routingKey);
      self.exchange.publish(routingKey, msg);

      queue.shift();
    });
  });
}

TaskAgent.prototype.setupQueues = function (taskQueues) {
  var self = this;

  self.setupPingQueue();

  var taskManagementQueues
    = [ { name: 'task_management'
        , maxConcurrent: 8
        , tasks:
          [ 'show_tasks'
          ]
        , onmsg: function (req) {
            var history = self.runner.taskHistory;
            var i = history.length;

            for (var i=history.length; i--; ) {
              var entry = history[i];
              var started_at = new Date(entry.started_at);
              var finished_at = entry.finished_at
                                ? new Date(entry.finished_at)
                                : new Date();
              entry.elapsed_seconds = (finished_at - started_at) / 1000;
            }

            req.event('finish', { history: history });
            req.finish();
          }
        }
      ];

  self.useQueues(taskManagementQueues);
  self.useQueues(taskQueues);
}
