# Node.js Clients for SmartDataCenter Services

Repository: <git@git.joyent.com:node-sdc-clients.git>
Browsing: <https://mo.joyent.com/node-sdc-clients>
Who: Mark Cavage and others
Tickets: <https://devhub.joyent.com/jira/browse/TOOLS> or the specific service


# Overview

Node.js client libraries for the various SDC REST API services: Amon, CA,
CNAPI, NAPI, UFDS, Packages on top of UFDS and VMAPI so far.

# Repository

    lib/                 Source files.
    test/                Test suite (using whiskey)
    tools/               Dev support tools
    Makefile
    package.json         npm module info (holds the project version)
    npm-shrinkwrap.json  Frozen npm module versions to setup.
    README.md            This.
    CHANGES.md           Changelog


# Development

Before commiting/pushing run `make prepush` and, if possible, get a code
review. Refer to the test section below for reference on setup and how to run
the test suites.

# Testing

Short version:

    make test

Of course, you may want to read some assumptions we made in order to ensure
the previous `make test` will run successfully.

Currently, every `test/*.test.js` file can be run separately as a different
test suite by issuing the proper commands:

    AMON_IP=10.99.99.206 \
    MACHINE_UUID=f56dbb40-1c81-4047-9d56-73fc3adf2b99 \
    make amon_test

    CA_IP=10.99.99.113 make ca_test

    make cnapi_test

    make ufds_test

    make package_test

    make vmapi_test

    make napi_test

    make imgapi_test

Each one of this commands assumes you've got a running version of the proper
API service.

For every service, the following environment variables can be provided to
indicate the IP addresses where these services are running:

    AMON_IP
    CA_IP
    CNAPI_IP
    UFDS_IP
    VMAPI_IP
    NAPI_IP

Of course, you provide each one of these environment variables to the proper
test suite make command and, in case you plan to run `make test`, i.e, all the
test suites, you may want to provide all these environment variables.

Also, note that `amon` test suite requires the UUID of a real machine to be
given as environment variable in order to be able to create real machine
probes (`MACHINE_UUID` env var).

Given UFDS, CNAPI, NAPI and VMAPI are services provided by the default headnode
core zones, if the associated IP env variables are not provided, the test
suites will set them to the default values into a COAL image running the
headnode; that is:

    CNAPI_IP=10.99.99.16
    UFDS_IP=10.99.99.13
    VMAPI_IP=10.99.99.18
    NAPI_IP=10.99.99.10

There are no default values pointing to the headnode zones for AMON and CA.
The default test values for these APIs point to `localhost` so, you may want
to either run them locally or pass in the values for these zones IPs.

So, in brief, requirements to run these test suites:

- Headnode setup, including AMON and CA zones. (Rememeber you need to provision
  Redis zone before you can create amon zone into the headnode).
- Run the following command:

    CNAPI_IP=10.99.99.16 \
    VMAPI_IP=10.99.99.18 \
    UFDS_IP=10.99.99.13 \
    NAPI_IP=10.99.99.10 \
    CA_IP=10.99.99.113 \
    AMON_IP=10.99.99.206 \
    MACHINE_UUID=f56dbb40-1c81-4047-9d56-73fc3adf2b99 \
    make test

with the different IP env vars pointing to the right IP for each zone.

Note that it's also possible to pass the ENV variable `ADMIN_PWD` to be used
with UFDS authentication tests. When not given, it will default to the
_traditional_ `joypass123`.

# TODO:

- Adding tests for CONFIG service is pending.
