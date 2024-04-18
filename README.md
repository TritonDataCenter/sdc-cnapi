<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2020 Joyent, Inc.
    Copyright 2024 MNX Cloud, Inc.
-->

# sdc-cnapi

This repository is part of the Triton Data Center project. See the [contribution
guidelines](https://github.com/TritonDataCenter/triton/blob/master/CONTRIBUTING.md)
and general documentation at the main
[Triton project](https://github.com/TritonDataCenter/triton) page.

CNAPI is responsible for maintaining the states and life-cycle stages of a
compute node. It communicates with compute nodes for the purpose of creating
and destroying tasks, initiating tasks, etc.

# Development

To run the  API server:

    git clone git@github.com:TritonDataCenter/sdc-cnapi.git
    cd cnapi
    git submodule update --init
    make all
    node bin/cnapi.js

To update docs, edit "docs/README.md" and run `make docs` if necessary in order
to update the Table of Contents.

Before commiting/pushing run `make prepush` and, if possible, get a code
review.


# Testing

    make test

The CNAPI_IP environment variable specifies the URL at which to point the test
suite.  For example, this would test CNAPI installed on bh1-kvm6:

    CNAPI_IP=10.2.206.13 make test

To test on a deployed CNAPI where the admin network is not directly accessible
from your workspace, first ensure your changes are applied (either via `sdcadm`
or the `tools/rsync-to` script) and then run:

    COAL=root@<headnode external IP> make test-coal
