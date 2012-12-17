var dox = require('dox');
var fs = require('fs');
var sprintf = require('sprintf').sprintf;

function parse(document) {
    var blocks = [];
    console.log(JSON.stringify(document, true, '  '));

    for (var idx in document) {
        var chunk = document[idx];
        if (chunk.ignore) {
            continue;
        }

        var block = { inputs: [], responses: []};
        block.summary = chunk.description.summary;
        block.body = chunk.description.body;

        for (var tagIdx in chunk.tags) {
            handleTag(block, chunk, tagIdx);
        }

        blocks.push(block);
    }

    return blocks;
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
        case 'input':
            m = (/^(\w+?)\s+(\w+?)\s+(.*)/g).exec(tag.string);
            block.inputs.push({ name: m[1], type: m[2], description: m[3] });
            break;
        case 'required-input':
            m = (/^(\w+?)\s+(\w+?)\s+(.*)/g).exec(tag.string);
            block.inputs.push({
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

function main() {
    var file = fs.readFileSync(process.argv[2]).toString();
    var a = dox.parseComments(file, { raw: true });
    var blocks = parse(a);
//     console.log(JSON.stringify(blocks, true, '  '));

    var ejs = require('ejs');
    var template
        = ejs.render(
            fs.readFileSync(
                'docs/index.md.ejs').toString(), { blocks: blocks });
    console.log(template);
}

main();
