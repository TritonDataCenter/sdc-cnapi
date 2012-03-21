execFile = require('child_process').execFile;

var execFileParseJSON = exports.execFileParseJSON = function (bin, args, callback) {
  execFile
    ( bin
    , args
    , function (error, stdout, stderr) {
        if (error)
          return callback(Error(stderr.toString()));
        var obj = JSON.parse(stdout.toString());
        callback(null, obj);
      }
    );
}

var sysinfo = exports.sysinfo = function (callback) {
  execFileParseJSON
    ( '/usr/bin/sysinfo'
    , []
    , function (error, config) {
        if (error)
          return callback(error);
        callback(null, config);
      }
    );
}

var sdcConfig = exports.sdcConfig = function (callback) {
  execFileParseJSON
    ( '/bin/bash'
    , [ '/lib/sdc/config.sh', '-json' ]
    , function (error, config) {
        if (error)
          return callback(error);
        callback(null, config);
      }
    );
}
