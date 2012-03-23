/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the CNAPI.
 */

var CNAPI = require('../lib/cnapi');

var cnapi = new CNAPI();
cnapi.start();
