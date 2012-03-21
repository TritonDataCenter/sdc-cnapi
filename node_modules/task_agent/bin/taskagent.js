#!/usr/bin/env node

var TaskAgent = require('../lib/task_agent');
var path = require('path');
var createTaskDispatchFn = require('../lib/dispatch').createTaskDispatchFn;

var tasksPath = path.join(__dirname, '../tasks');

var options = { reconnect: true, resource: 'taskagent' };
var agent = new TaskAgent(options);

var queueDefns
  = [ { name: 'demo_tasks'
      , maxConcurrent: 4
      , tasks:
          [ 'demo' ]
      , onmsg: createTaskDispatchFn(agent, tasksPath)
      }
    ];

agent.configureAMQP(function () {
  agent.connect(function () {
    agent.setupQueues(queueDefns);
  });
});
