function Model(options) {
    this.options = options;
    this.servers = [ { uuid: '123', hostname: 'testserver' } ];
}

Model.prototype.getServers = function (callback) {
    return callback(null, this.servers);
};

Model.prototype.getServer = function (uuid, callback) {
    return callback(null, this.servers[0]);
};

function createModel(options) {
    return new Model();
}

exports.createModel = createModel;
exports.createUfdsModel = createModel;
exports.Model = Model;
