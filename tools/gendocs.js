#!/usr/node/bin/node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/**
 * Generate docs/index.md from parsing of dox comments in JS code
 * and the docs/index/index.md.ejs template.
 *
 * Usage:
 *      make regen_docs
 */

var assert = require('assert-plus');
var ejs = require('ejs');
var dox = require('dox');
var fs = require('fs');
var sprintf = require('sprintf').sprintf;
var file = require('file');
var async = require('async');
var path = require('path');


/**
 * Sort an array of objects (in-place).
 *
 * @param items {Array} The array of objects to sort.
 * @param fields {Array} Array of field names (lookups) on which to sort --
 *      higher priority to fields earlier in the array. The comparison may
 *      be reversed by prefixing the field with '-'. E.g.:
 *          ['-age', 'lastname', 'firstname']
 * @param options {Object} Optional.
 *      - dottedLookup {Boolean}
 *
 * From node-tabula.
 */
function sortArrayOfObjects(items, fields, options) {
    assert.optionalObject(options, 'options');
    if (!options) {
        options = {};
    }
    assert.optionalBool(options.dottedLookup, 'options.dottedLookup');
    var dottedLookup = options.dottedLookup;

    function cmp(a, b) {
        for (var i = 0; i < fields.length; i++) {
            var field = fields[i];
            var invert = false;
            if (field[0] === '-') {
                invert = true;
                field = field.slice(1);
            }
            assert.ok(field.length, 'zero-length sort field: ' + fields);
            var a_field, b_field;
            if (dottedLookup) {
                // This could be sped up by bring some processing out of `cmp`.
                var lookup = new Function('return this.' + field);
                try {
                    a_field = lookup.call(a);
                } catch (e) {}
                try {
                    b_field = lookup.call(b);
                } catch (e) {}
            } else {
                a_field = a[field];
                b_field = b[field];
            }
            var a_cmp = Number(a_field);
            var b_cmp = Number(b_field);
            if (isNaN(a_cmp) || isNaN(b_cmp)) {
                a_cmp = a_field;
                b_cmp = b_field;
            }
            // Comparing < or > to `undefined` with any value always
            // returns false.
            if (a_cmp === undefined && b_cmp === undefined) {
                /* jsl:pass */
            } else if (a_cmp === undefined) {
                return (invert ? 1 : -1);
            } else if (b_cmp === undefined) {
                return (invert ? -1 : 1);
            } else if (a_cmp < b_cmp) {
                return (invert ? 1 : -1);
            } else if (a_cmp > b_cmp) {
                return (invert ? -1 : 1);
            }
        }
        return 0;
    }
    items.sort(cmp);
}

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
        case 'param':
            block.params.push({
                name: tag.name,
                type: tag.types[0],
                description: tag.description.replace(/\n/g, ' ')
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

function getTableCellWidths(params) {
    var widths = params.headers.map(function (h) { return h.length; });

    params.data.forEach(function (row) {
        for (var i in params.fields) {
            var field = params.fields[i];

            if (row.hasOwnProperty(field) &&
                row[field].length > widths[i] ||
                !widths[i])
            {
                if (i > widths.length)  {
                    widths.push(row[field].length);
                } else {
                    widths[i] = row[field].length;
                }
            }
        }
    });

    return widths;
}

function makeTable(params) {
    var fields = params.fields;
    var widths = getTableCellWidths(params);

    var rowsout = [];
    params.data.forEach(function (row) {
        var rowout = [];

        var i;
        for (i in fields) {
            var field = fields[i];
            if (row.hasOwnProperty(field)) {
                rowout.push(row[field]);
            } else {
                rowout.push('');
            }
        }
        rowsout.push(rowout);
    });

    var padded = [];
    var headerlines = '';
    var headerout;

    headerout = '| ' + params.headers.map(function (c, w) {
        return sprintf('%-'+widths[w]+'s', c);
    }).join(' | ') + ' |';

    headerlines = '| ' + fields.map(function (f, fi) {
        return (new Array(1+widths[fi])).join('-');
    }).join(' | ') + ' |';

    padded = rowsout.map(function (row) {
        return '| ' + row.map(function (c, w) {
            return sprintf('%-'+widths[w]+'s', c);
        }).join(' | ') + ' |';
    });

    return headerout + '\n' + headerlines + '\n' + padded.join('\n');
}

function main() {
    if (process.argv.length < 3) {
        console.error('Error: Insufficient number of arguments');
        console.error('%s %s [static markdown file] <directory>',
                      process.argv[0], process.argv[1]);
        process.exit(1);
    }

    var data = fs.readFileSync(__dirname + '/../package.json');
    var pkg = JSON.parse(data.toString());
    var staticData = '';
    var directory;

    if (process.argv.length === 3) {
        directory = process.argv[2];
    } else if (process.argv.length === 4) {
        staticData = fs.readFileSync(process.argv[2]).toString();
        directory = process.argv[3];
    }

    var files = [];
    file.walkSync(directory, function (dir, dirs, filenames) {
        filenames.forEach(function (fn) {
            if (/\.js$/.exec(fn)) {
                files.push(path.join(dir, fn));
            }
        });
    });

    var endpointsFromSectionName = {};

    files.forEach(function (fn) {
        var doc = processFile(fn);
        for (var name in doc) {
            if (endpointsFromSectionName[name]) {
                endpointsFromSectionName[name]
                    = endpointsFromSectionName[name].concat(doc[name]);
            } else {
                endpointsFromSectionName[name] = doc[name];
            }
        }
    });

    var sections = [];
    Object.keys(endpointsFromSectionName).forEach(function (name) {
        sections.push({
            name: name,
            endpoints: endpointsFromSectionName[name]
        });
    });
    // Sort sections by name for stable doc section order.
    sortArrayOfObjects(sections, ['name']);

    var expanded = ejs.render(fs.readFileSync(
        __dirname + '/../docs/index/index.md.ejs').toString(),
        {
            package: pkg,
            makeTable: makeTable,
            sections: sections,
            static: staticData
        });
    process.stdout.write(expanded);
}

main();
