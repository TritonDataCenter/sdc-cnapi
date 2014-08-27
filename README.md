<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# Compute Node API

Repository: <git@git.joyent.com:cnapi.git>
Browsing: <https://mo.joyent.com/cnapi>
Who: ?
Docs: <https://head.no.de/docs/cnapi>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/CNAPI>


# Overview

CNAPI is responsible for maintaining the states and life-cycle stages of a
compute node. It communicates with compute nodes for the purpose of creating
and destroying tasks, initiating tasks, etc.

# Repository

    deps/           Git submodules and/or commited 3rd-party deps should go
                    here. See "node_modules/" for node.js deps.
    docs/           Project docs (restdown)
    lib/            Source files.
    node_modules/   Node.js deps, either populated at build time or commited.
                    See Managing Dependencies.
    pkg/            Package lifecycle scripts
    smf/manifests   SMF manifests
    smf/methods     SMF method scripts
    test/           Test suite (using node-tap)
    tools/          Miscellaneous dev/upgrade/deployment tools and data.
    Makefile
    package.json    npm module info (holds the project version)
    README.md


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
