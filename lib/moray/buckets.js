module.exports = {
    'servers': {
        name: 'cnapi_servers',
        bucket: {
            index: {
                uuid: { type: 'string', unique: true },
                setup: { type: 'boolean' },
                headnode: { type: 'boolean' },
                datacenter: { type: 'string' }
            }
        }
    }
};
