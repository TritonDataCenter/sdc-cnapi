var taskModule = process.argv[2];
var TaskClass = require(taskModule + '.js');

var info = function (message) {
  process.send
    ( { type: 'log'
      , entry: { level: 'info', message: message }
      }
    );
};

var error = function (message) {
  process.send
    ( { type: 'log'
      , entry: { level: 'error', message: message }
      }
    );
};

var debug = function (message) {
  process.send
    ( { type: 'log'
      , entry: { level: 'debug', message: message }
      }
    );
};

var isString = function (obj) {
  return Object.prototype.toString.call(obj) === '[object String]';
}


info("task_worker started");

debug("Child ready to start, sending ready event to parent");
process.send({ type: 'ready' });

process.on('SIGTERM', function () {
  info("Task processes terminated. Exiting.");
  process.exit(0);
});

process.on('uncaughtException', function (err) {
  process.send ({ type: 'exception' , error: err });
  error("Uncaught exception in task child process: ");
  error(err.message);
  error(err);
  process.exit(1);
});


process.on('message', function (msg) {
  debug("Child received hydracp message from parent:");
  debug(msg);
  switch (msg.action) {
    case 'start':
      start(msg.req, msg.tasksPath);
      break;
    case 'subtask':
      var fn = task.subTaskCallbacks[msg.id];
      fn.apply(task, [msg.name, msg.event]);
      break;
  }
});

var task;

function start (req, tasksPath) {
  info("Instantiating '" + taskModule+ "'");
  info("task_id: " + req.params.task_id);
  info("client_id: " + req.params.client_id);
  task = new TaskClass(req);
  task.req = req;
  task.tasksPath = tasksPath;

  task.on('event', function (name, event) {
    info("Received event (" + name + ") from task instance:");
    debug(event);
    process.send({ type: 'event', name: name, event: event });
  });

  task.on('log', function (entry) {
    process.send({ type: 'log', entry: entry });
  });

  task.on('subtask', function (event) {
    info("Received a subtask event from task instance:");
    debug(event);
    process.send
      ( { type: 'subtask'
        , resource: event.resource
        , task: event.task
        , msg: event.msg
        , id: event.id
        }
      );
  });

  task.start();
}

