<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdc-cnapi

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

CNAPI is responsible for maintaining the states and life-cycle stages of a
compute node. It communicates with compute nodes for the purpose of creating
and destroying tasks, initiating tasks, etc.

# Development

To run the  API server:

    git clone git@git.joyent.com:cnapi.git
    cd cnapi
    git submodule update --init
    make all
    node bin/cnapi.js

To update the guidelines, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.


# Testing

    make test

The CNAPI_IP environment variable specifies the URL at which to point the test
suite.  For example, this would test CNAPI installed on bh1-kvm6:

    CNAPI_IP=10.2.206.13 make test
