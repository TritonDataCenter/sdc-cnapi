var dox = require('dox');
var fs = require('fs');
var sprintf = require('sprintf').sprintf;
var file = require('file');
var async = require('async');
var path = require('path');

function parse(document) {
    var parsed = {};

    for (var idx in document) {
        var chunk = document[idx];
        if (chunk.ignore) {
            continue;
        }

        var block = { params: [], responses: []};
        block.summary = chunk.description.summary;
        block.body = chunk.description.body;

        for (var tagIdx in chunk.tags) {
            handleTag(block, chunk, tagIdx);
        }
        if (block.name) {
            if (!parsed[block.section]) {
                parsed[block.section] = [];
            }
            parsed[block.section].push(block);
        }

    }

    return parsed;
}

function handleTag(block, chunk, idx) {
    var tag = chunk.tags[idx];
    var m;
    switch (tag.type) {
        case 'name':
            block.name = tag.string;
            break;
        case 'endpoint':
            block.endpoint = tag.string;
            break;
        case 'section':
            block.section = tag.string;
            break;
        case 'params':
            m = (/^(\w+?)\s+(\w+?)\s+(.*)/g).exec(tag.string);
            block.params.push({ name: m[1], type: m[2], description: m[3] });
            break;
        case 'required-params':
            m = (/^(\w+?)\s+(\w+?)\s+(.*)/g).exec(tag.string);
            block.params.push({
                name: m[1], type: m[2], required: false, description: m[3]
            });
            break;
        case 'response':
            m = (/^(\w+?)\s+(\w+?)\s+(.*)/g).exec(tag.string);
            block.responses.push({
                code: m[1], type: m[2], required: true, description: m[3]
            });
            break;
        default:
            break;
    }
}

function processFile(fn) {
    var contents = fs.readFileSync(fn).toString();
    var a = dox.parseComments(contents, { raw: true });
    var doc = parse(a);

    return doc;
}

function main() {
    var files = [];
    file.walkSync(process.argv[2], function (dir, dirs, filenames) {
        filenames.forEach(function (fn) {
            if (/\.js$/.exec(fn)) {
                files.push(path.join(dir, fn));
            }
        });
    });

    var parsed = {};

    files.forEach(function (fn) {
        var doc = processFile(fn);

        for (var s in doc) {
            parsed[s] = doc[s];
        }
    });

    var ejs = require('ejs');
    var expanded = ejs.render(fs.readFileSync(
        __dirname + '/../docs/index/index.md.ejs').toString(),
        { doc: parsed });
    process.stdout.write(expanded);
}

main();
