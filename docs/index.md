---
title: CNAPI (Compute Node API) Design
apisections: Allocation API, Boot Parameters API, Compute Node Agent Tasks API, Miscellaneous API, Remote Execution API (deprecated), Server API, Virtual Machine API, Virtual Machine Images API, Virtual Machine Snapshots API, Waitlist API, ZFS API (deprecated)
markdown2extras: tables, code-friendly
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2019, Joyent, Inc.
-->

<!--

    WARNING! index.md is generated from:

        docs/index/index.md.ejs.
        docs/static

    Make your edits there or risk having them lost during the automatic
    documentation generation.

-->



<!-- Static component of documentation -->

# Overview

CNAPI is the 'Compute Node API' which presents an API to communicate and
interact with Compute Nodes (CNs).

# Responsibilities

CNAPI provides a unified interface to common Compute Node operations, such as
server setup, factory-resetting, virtual machine life-cycle actions (creation,
state transitions, destruction, etc.) In general, if it needs to talk to
compute nodes, it should happen through CNAPI.

# Compute Node Startup

When a compute node is started up from a shutdown state, regardless if it has
been set up, it will broadcast a message containing the payload from the
sysinfo utility. This broadcast message is picked up by CNAPI.

# Configuration

Reference for configuration variables in cnapi, which are stored in
config/config.json in a running setup. An example of this configuration can be
found in sapi_manifests/cnapi/template.

| Var                       | Type   | Default | Description                                                         |
| ------------------------- | ------ | ------- | ------------------------------------------------------------------- |
| **logLevel**              | String | info    | Level at which to log. One of the supported Bunyan log levels.      |
| **datacenter_name**       | String | -       | Name of the SDC datacenter on which CNAPI is running.               |
| **adminUuid**             | String | -       | The UUID of the admin user in this SDC standup.                     |
| **amqp**                  | Object | -       | If either transport above specifies "amqp", this section is needed. |
| **amqp.host**             | String | -       | Host of AMQP broker.                                                |
| **moray.host**            | String | -       | The Moray API URL.                                                  |
| **moray.port**            | Number | 2020    | The Moray API port.                                                 |
| **api.port**              | Number | 80      | Port number on which to listen.                                     |
| **wfapi.workflows**       | Array  | []      | Array of workflows to load.                                         |
| **wfapi.url**             | String | -       | The Workflow API URL.                                               |
| **napi.url**              | String | -       | The NAPI API URL.                                                   |
| **assets.url**            | String | -       |                                                                     |
| **cnapi.url**             | String | -       | The CNAPI API URL (e.g. of this instance)                           |
| **imgapi.url**            | String | -       | The IMGAPI API URL.                                                 |
| **dapi.changeDefaults**   | Object | -       | This provides some means to override VM allocation behaviour.       |
| **dapi.changeDefaults.server_spread**        | String | -            | **DEPRECATED** How VMs are spread across CNs (one of: min-ram, max-ram, min-owner, and random)   |
| **dapi.changeDefaults.filter_docker_min_platform** | String | -      | If present, minimum platform version useful for Docker instances.        |
| **dapi.changeDefaults.filter_flexible_disk_min_platform** | String | - | If present, minimum platform version useful for instances with flexible disk sizing. |
| **dapi.changeDefaults.filter_headnode**      | String | true         | Whether VMs cannot allocate on the headnode.                             |
| **dapi.changeDefaults.filter_min_resources** | String | true         | Whether CPU/RAM/disk limits are ignored when allocating.                 |
| **dapi.changeDefaults.filter_large_servers** | String | true         | Whether large servers are reserved for larger allocations.               |
| **dapi.changeDefaults.overprovision_ratio_cpu**  | String | 4.0      | How much CPU will be overprovisioned per CN by default.                  |
| **dapi.changeDefaults.overprovision_ratio_ram**  | String | 1.0      | How much RAM will be overprovisioned per CN by default.                  |
| **dapi.changeDefaults.overprovision_ratio_disk** | String | 1.0      | How much disk will be overprovisioned per CN by default.                 |
| **dapi.changeDefaults.disable_override_overprovisioning** | String | false | Whether to turn off the hard setting of defaults for provisioning across CNs and packages. |
| **dapi.changeDefaults.weight_current_platform**  | String     | 1.0  | Bias selection towards CNs with newer platforms.                         |
| **dapi.changeDefaults.weight_next_reboot**       | String     | 0.5  | Bias selection away from CNs with nearer scheduled reboots.              |
| **dapi.changeDefaults.weight_num_owner_zones**   | String     | 0.0  | Bias selection away from CNs with more VMs belonging to the current owner. |
| **dapi.changeDefaults.weight_uniform_random**    | String     | 0.5  | Bias selection towards random CNs.                                       |
| **dapi.changeDefaults.weight_unreserved_disk**   | String     | 1.0  | Bias selection towards CNs with more unreserved disk.                    |
| **dapi.changeDefaults.weight_unreserved_ram**    | String     | 2.0  | Bias selection towards CNs with more unreserved disk.                    |
| **dapi.allocationDescription**               | Array  | see template | The pipeline used by the allocator to decide where a VM goes across CNs. |

dapi.changeDefaults is a bit of an oddball, due to limitations in the hogan.js
template engine. Booleans are represented by the "true" and "false" strings, not
raw booleans; an empty string is treated as the default value. Be careful when
changing from the defaults in production.


# SAPI Configuration

When using the config-agent service in the CNAPI zone, which draws metadata from
SAPI, it's possible to change the dapi.changeDefaults outlined in the
`Configuration` section above.

In the SAPI "cnapi" service, adding or changing the following keys in
`metadata` will affect allocation behaviour. This is useful for testing, or
specialized circumstances in production.

| Key                            | Type    | Default | Description                                                                  |
| ------------------------------ | ------- | ------- | ---------------------------------------------------------------------------- |
| **ALLOC_SERVER_SPREAD**        | String  | -       | **DEPRECATED** How the allocator spreads VMs across CNs.                     |
| **ALLOC_FILTER_HEADNODE**      | Boolean | true    | Whether the headnode should be removed from consideration during allocation. |
| **ALLOC_FILTER_MIN_DISK**      | Boolean | false   | Whether CNs with insufficient spare disk should be removed.                  |
| **ALLOC_FILTER_MIN_RESOURCES** | Boolean | true    | Whether CNs with insufficient spare CPU/RAM/disk should be removed.          |
| **ALLOC_FILTER_LARGE_SERVERS** | Boolean | true    | Whether large servers should be reserved primarily for large allocations.    |
| **ALLOC_FILTER_VM_COUNT**      | Integer | 224     | CNs with equal or more VMs than this will be removed from consideration.     |
| **ALLOC_FILTER_DOCKER_MIN_PLATFORM**        | String  | -     | If present, minimum platform version useful for Docker instances. |
| **ALLOC_DISABLE_OVERRIDE_OVERPROVISIONING** | Boolean | false | If true, allow packages and CNs to dictate overprovision ratios.  |
| **ALLOC_OVERRIDE_OVERPROVISION_CPU**        | Float   | 4.0   | The ratio of CPU overprovisioning that will be hard set.          |
| **ALLOC_OVERRIDE_OVERPROVISION_RAM**        | Float   | 1.0   | The ratio of RAM overprovisioning that will be hard set.          |
| **ALLOC_OVERRIDE_OVERPROVISION_DISK**       | Float   | 1.0   | The ratio of disk overprovisioning that will be hard set.         |
| **ALLOC_WEIGHT_CURRENT_PLATFORM**  | Float | 1.0   | Bias selection towards CNs with newer platforms.                             |
| **ALLOC_WEIGHT_NEXT_REBOOT**       | Float | 0.5   | Bias selection away from CNs with nearer scheduled reboots.                  |
| **ALLOC_WEIGHT_NUM_OWNER_ZONES**   | Float | 0.0   | Bias selection away from CNs with more VMs belonging to the current owner.   |
| **ALLOC_WEIGHT_UNIFORM_RANDOM**    | Float | 0.5   | Bias selection towards random CNs.                                           |
| **ALLOC_WEIGHT_UNRESERVED_DISK**   | Float | 1.0   | Bias selection towards CNs with more unreserved disk.                        |
| **ALLOC_WEIGHT_UNRESERVED_RAM**    | Float | 2.0   | Bias selection towards CNs with more unreserved memory.                      |
| **FEATURE_USE_CNAGENT_COMMAND_EXECUTE** | Boolean | false | Experimental: Use cn-agent's command_execute function instead of Ur when available. |
| **SMT_ENABLED_DEFAULT**	| Boolean | true | The default simultaneous multi-threading mode for newly-installed CNs. |

If any of the keys above aren't in the `sdc` `metadata` section, it's treated as
if the default value was specified. Be careful when changing from the default
values in production.

ALLOC_SERVER_SPREAD is deprecated in favour of ALLOC_WEIGHT_\*.  It can have one
of four values: `min-ram`, `max-ram`, `min-owner`, and `random`.  `min-ram`
selects CNs which have the least amount of sufficient space for a new VM.
`max-ram` selects CNs which have the *most* amount of free space.  `min-owner`
makes the allocator much more aggressive about balancing all VMs belonging to
one user across all CNs. And `random` assigns randomly across CNs.


ALLOC_WEIGHT_\* attributes can have negative values, not just positive. Negative
values have the opposite effect of negative values; e.g. a postive
ALLOC_WEIGHT_NUM_OWNER_ZONES biases selection towards CNs with fewer VMs
belonging to the owner of the current allocation, while a negative value would
bias towards CNs with more such VMs.

A note of warning about ALLOC_FILTER_MIN_DISK: if this is set to true, but
ALLOC_FILTER_MIN_RESOURCES is set to false, then disk checks will be ignored.
Both must be true for disk checks to proceed.

ALLOC_OVERRIDE_OVERPROVISION_\* is playing with fire. While twiddling with the
default cpu overprovision ratio is fairly safe, RAM and disk are hazardous to
increase beyond 1.0 if KVM instances are ever provisioned; it can lead to KVM
instances which cannot boot, or KVM instances with corrupt filesystems.  It's
recommended you don't fiddle with these values unless you know what you're
doing, have tested this heavily before pushing to production, and are willing to
deal with the consequences if things go bad.

ALLOC_DISABLE_OVERRIDE_OVERPROVISIONING should only be set to true if all CNs
and packages have had sane overprovision values set, after careful consideration
of how the DC will be split up for the differing ratios. If in doubt, don't
change the default.

FEATURE_USE_CNAGENT_COMMAND_EXECUTE should only be set true if you want CNAPI to
send CommandExecute requests to a CN via cn-agent's `command_execute` task when
that is available (I.e. cn-agent is new enough). If this is false (the default)
or if a CN does not have a new enough cn-agent to support `command_execute`, the
CommandExecute will fall back to using Ur transparently. Enabling this is
currently considered experimental as its backward compatibility has not been
tested with the full spectrum of possible production scripts.

### Example

    cnapi_svc=$(sdc-sapi /services?name=cnapi | json -Ha uuid)
    sdc-sapi /services/$cnapi_svc -X PUT -d '{ "metadata": { "ALLOC_FILTER_HEADNODE": false } }'

# Interacting with CNAPI

There are two ways of interacting with CNAPI. Indirectly: eg. adminui, cloudapi,
workflow, vmapi. Directly: eg. sdc-cnapi, sdc-server, curl.

Use it as so:

    -bash-4.1# sdc-cnapi /servers/5e4bafa8-9dfd-11e3-982d-a7dee2e79ac4 \
                    -X POST \
                    -d '{ "datacenter_name": "foo" }'


# Metrics

CNAPI exposes metrics via [node-triton-metrics](https://github.com/joyent/node-triton-metrics) on `http://<ADMIN_IP>:8881/metrics.`

# Heartbeats

After setup, each server is populated with agents which allow the Triton
services to monitor and perform actions on these servers. One of these agents is
`cn-agent`, its responsibility is to execute tasks on the server and to
periodically post server usage and information to CNAPI. CNAPI in turn uses
these heartbeat events to determine whether a server is running.

Every time CNAPI receives a heartbeat via POST to
`/servers/:uuid/events/heartbeat`, CNAPI updates its in-memory store which maps
server\_uuid to last\_heartbeat, setting the value to the current time.

Every `HEARTBEAT_RECONCILIATION_PERIOD_SECONDS` (currently 5) seconds, CNAPI
will check the heartbeats stored in its in-memory store and for each server:

 * If the `last_heartbeat` is not stale (more on this below), it does nothing
   for this server.

 * If CNAPI has not previously written data for this server, it tries to
   add/update an entry to the `cnapi_status` bucket in moray. If successful, it
   will also try to update the server's `status` property to `running`.

 * If the `last_heartbeat` is stale, it tries to update the `cnapi_status`
   bucket in moray with the last last\_heartbeat value this CNAPI has seen.
   If the `cnapi_status` entry is updated, the server's `status` it also
   attempts to set the `status` property to `unknown` for this server.

To determine whether a heartbeat is "stale", CNAPI compares the last\_heartbeat
against the current time. If the last heartbeat is more than
`HEARTBEAT_LIFETIME_SECONDS` seconds old, the heartbeat is considered stale.
The process that runs periodically to check heartbeats is called the reconciler.

Any time CNAPI writes to the `cnapi_status` bucket, it also includes the
`cnapi_instance` property identifying the CNAPI instance in which the value was
observed. This way, if there are multiple CNAPI's, it is possible to determine
which CNAPI has last received heartbeats for a given CN.

There are a few artedi metrics that are exposed related to heartbeating. These
will be available when polling the /metrics endpoint with prometheus. The
available metrics are:

## heartbeating_servers_count

A gauge indicating how many servers have recently (within the heartbeat
lifetime) heartbeated to this server.

## reconciler_new_heartbeaters_total

A counter that indicates how many times this CNAPI has seen a heartbeat from a
new server, or a server that it had forgotten (e.g. because it went stale).

## reconciler_stale_heartbeaters_total

A counter that indicates the number of times CNAPI noticed that a server had not
heartbeated recently and the last_heartbeat was considered stale.

## reconciler_usurped_heartbeaters_total

A counter that indicates the of times CNAPI went to update cnapi\_status but
found that another server had updated it more recently.

## reconciler_server_put_total

A counter indicating the number of times CNAPI attempted to put cnapi\_servers
objects into moray.

## reconciler_server_put_etag_failures_total

A counter indicating how many times there were Etag failures putting
cnapi\_servers objects into moray because the data changed between get and put.

## reconciler_server_put_failures_total

A counter indicating the total number of putObject calls to cnapi\_servers
have failed.

## reconciler_status_put_total

A counter indicating the number of times CNAPI attempted to put cnapi\_status
objects into moray.

## reconciler_status_put_etag_failures_total

A counter indicating how many times there were Etag failures putting
cnapi\_status objects into moray because the data changed between get and put.

## reconciler_status_failures_total

A counter indicating the total number of putObject calls to cnapi\_status
have failed.


# Resetting to Factory Defaults

To reset a compute node to its factory default state, `PUT` to the server's
`factory-reset` endpoint:

    -bash-4.1# sdc-cnapi /servers/564d5f0d-3517-5f60-78f1-ce6d0b8f58df/factory-reset \
                    -X PUT
    HTTP/1.1 202 Accepted
    Content-Type: application/json
    Content-Length: 51
    Date: Tue, 25 Feb 2014 09:24:52 GMT
    Server: Compute Node API
    x-request-id: ae6426e0-9dfe-11e3-96ca-d3493bcec4fe
    x-response-time: 28
    x-server-name: a6b7ba97-deb7-44b1-85da-3d7ae328c710
    Connection: keep-alive

    {
      "job_uuid": "4a664491-aa29-4d77-9fc2-592308d56922"
    }

The UUID of the factory reset job is returned and can be used to poll for the
completion of the operation.


# Virtual Machine Actions

One of the main mechanisms via which CNAPI interacts with compute nodes VMs is via
AMQP messages sent to and received from the provisioner agent on the compute
node.


    -bash-4.1# sdc-cnapi /servers/$(sysinfo |json UUID)/vms/f9940090-a065-11e3-81fd-274008e46b67machine_reboot \
            -X POST \
            -d '{}'

See the reference for the API for available VM endpoitns.



# Remote Execution (deprecated)

*IMPORTANT: This functionality is deprecated and will be removed in a future
release. It exists only for backward compatibility and should not be used for
any new development. If you wish to execute commands on a CN, this should be
done through a new cn-agent task, or a new agent.*

CNAPI exposes a mechanism to allow remote execution of commands.

    -bash-4.1# sdc-cnapi /servers/$(sysinfo |json UUID)/execute \
            -X POST \
            -d '{ "script": "#!/bin/bash\necho hi $1 $FOO", "args": ["hello"],
                  "env": { "FOO": "1" } }'

Using the script, args, and env properties we can control the source we
execute, the arguments to that script and any environment variables.


# Boot parameters

When a compute node boots up, its boot-loader fetches the necessary information
from booter. These booter in turn requests this data, consisting of
`platform`, `kernel_flags` and `kernel_modules` from CNAPI.

Operations on boot parameters are done via the `/boot` endpoint.

On the the initial, boot from a "factory default" state, the "default" boot
parameters will be fetched from the `/boot/default` endpoint.

Setting the default boot platform for new compute nodes:

    -bash-4.1# sdc-cnapi /boot/ac586cae-9ace-11e3-a64e-7f4008875a90 \
        -X PUT \
        -d '{ "platform": "20140219T205617Z" }'


Kernel arguments are key/value pairs passed in to the kernel. They are distinct
from kernel flags.

For example, to set the kernel arguments and flags for a compute node with uuid
21306a50-9dad-11e3-9404-53f0c3de6cb8:

    -bash-4.1# sdc-cnapi /boot/21306a50-9dad-11e3-9404-53f0c3de6cb8 \
        -X POST
        -d '{ "kernel_args": { "foo": "bar" }, "kernel_flags": { "-k": true } }'

The same as the above, but with -kd:

    -bash-4.1# sdc-cnapi /boot/21306a50-9dad-11e3-9404-53f0c3de6cb8 \
        -X POST
        -d '{ "kernel_args": { "foo": "bar" }, "kernel_flags": { "-kd": true } }'

Setting `noimport`:

    -bash-4.1# sdc-cnapi /boot/21306a50-9dad-11e3-9404-53f0c3de6cb8 \
        -X POST
        -d '{ "kernel_args": { "noimport": "true" } }'


Passing `null` as the value to a key deletes that key/value.

For instance, to delete the `foo` key:

    sdc-cnapi /boot/21306a50-9dad-11e3-9404-53f0c3de6cb8 \
        -X POST
        -d '{ "kernel_args": { "foo": null } }'


To completely overwrite values, use PUT instead of POST:

    -bash-4.1# sdc-cnapi /boot/21306a50-9dad-11e3-9404-53f0c3de6cb8 \
        -X PUT
        -d '{ "kernel_args": { "alpha": "able" } }'


# Setting up a new Server

Setting when a new server comes online its `status` should be be visible as
'running', and its `setup` state should be `'unsetup'`:

    -bash-4.1# sdc-cnapi /servers | json -Hga uuid setup status
    564d2cec-76f9-2438-7f66-9140267bed05 true running
    564d5f0d-3517-5f60-78f1-ce6d0b8f58df false running


To set up the new server, one may use one of the indirect methods (adminui,
etc).

Additionally, one may also use `sdc-server`:

    -bash-4.1# sdc-server setup 564d5f0d-3517-5f60-78f1-ce6d0b8f58df


Or, sdc-cnapi:

    -bash-4.1# sdc-cnapi /servers/564d5f0d-3517-5f60-78f1-ce6d0b8f58df/setup \
                    -X PUT


To run a script after successful setup completion, use the `postsetup_script`
parameter. The script will be run within the global zone of the compute node in
question:

    -bash-4.1# sdc-cnapi /servers/564d5f0d-3517-5f60-78f1-ce6d0b8f58df/setup -X PUT -d '{ "postsetup_script": "#!/bin/bash\necho > /var/tmp/myfile" }'


# Updating Nics

The only parameter of the server's nics that can be changed is
nic_tags_provided. This parameter can be changed depending on the following
values for the *action* parameter:

* update: Add nic tags to the target nics
* replace: Replace the nic tags (ie: completely overwrite the list) for the
  target nics
* delete: Remove the nic tags from the target nics

## Examples

**update**

Add the manta nic tag to a nic with sdc-cnapi:

    sdc-cnapi /servers/564d4d2c-ddd0-7be7-40ae-bae473a1d53e/nics \
    -X PUT '\
        {
            "action": "update",
            "nics": [
                {
                    "mac": "00:0c:29:a1:d5:3e",
                    "nic_tags_provided": [ "manta" ]
                }
            ]
        }'

Or with sdc-server:

    sdc-server update-nictags -s 564d4d2c-ddd0-7be7-40ae-bae473a1d53e \
        manta_nic=00:0c:29:a1:d5:3e

**replace**

Set the nic tags for a nic to external and mantanat (removing all other nic
tags) with sdc-cnapi:

    sdc-cnapi /servers/564d4d2c-ddd0-7be7-40ae-bae473a1d53e/nics \
    -X PUT '\
        {
            "action": "replace",
            "nics": [
                {
                    "mac": "00:0c:29:a1:d5:3e",
                    "nic_tags_provided": [ "external", "mantanat" ]
                }
            ]
        }'

Or with sdc-server:

    sdc-server replace-nictags -s 564d4d2c-ddd0-7be7-40ae-bae473a1d53e \
        external_nic=00:0c:29:a1:d5:3e mantanat_nic=00:0c:29:a1:d5:3e

**delete**

Remove the mantanat nic tag from a nic with sdc-cnapi:

    sdc-cnapi /servers/564d4d2c-ddd0-7be7-40ae-bae473a1d53e/nics \
    -X PUT '\
        {
            "action": "delete",
            "nics": [
                {
                    "mac": "00:0c:29:a1:d5:3e",
                    "nic_tags_provided": [ "mantanat" ]
                }
            ]
        }'

Or with sdc-server:

    sdc-server delete-nictags -s 564d4d2c-ddd0-7be7-40ae-bae473a1d53e \
        mantanat_nic=00:0c:29:a1:d5:3e

# Server records


A CNAPI server record looks like the following

    -bash-4.1# sdc-cnapi /servers
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 9848
    Date: Tue, 22 Apr 2014 08:35:10 GMT
    Server: Compute Node API
    x-request-id: 03f340c0-c9f9-11e3-9a2b-e36882367c85
    x-response-time: 15
    x-server-name: c587f0fc-a962-49cb-a4d2-cd9cb0efb9b9
    Connection: keep-alive

    {
      "sysinfo": {
         --- compute node sysinfo ---
      },
      "ram": 4095,
      "current_platform": "20140421T214627Z",
      "headnode": true,
      "boot_platform": "20140421T214627Z",
      "datacenter": "coal",
      "overprovision_ratio": 1,
      "reservation_ratio": 0.15,
      "reservoir": false,
      "traits": {},
      "rack_identifier": "",
      "comments": "",
      "uuid": "564d4374-d703-b97b-ca9f-7375f05f337c",
      "hostname": "headnode",
      "reserved": false,
      "boot_params": {
        "rabbitmq": "guest:guest:rabbitmq.coal.joyent.us:5672"
      },
      "kernel_flags": {},
      "default_console": "vga",
      "serial": "ttyb",
      "setup": true,
      "setting_up": false,
      "last_boot": "2014-04-22T07:39:50.000Z",
      "created": "2014-04-22T07:37:30.000Z",
      "vms": {
         --- compute node vm objects ---
      },
      "transitional_status": "",
      "last_heartbeat": "2014-04-22T08:35:07.776Z",
      "status": "running",
      "memory_available_bytes": 2044813312,
      "memory_arc_bytes": 184096272,
      "memory_total_bytes": 4284993536,
      "memory_provisionable_bytes": -44936986624,
      "disk_kvm_zvol_used_bytes": 0,
      "disk_kvm_zvol_volsize_bytes": 0,
      "disk_kvm_quota_bytes": 0,
      "disk_zone_quota_bytes": 536870912000,
      "disk_cores_quota_bytes": 429496729600,
      "disk_installed_images_used_bytes": 950053376,
      "disk_pool_size_bytes": 159987531776,
      "overprovision_ratios": {
        "ram": 1
      },
      "unreserved_cpu": 400,
      "unreserved_ram": -42863,
      "unreserved_disk": 151669
    }

## Server properties

| Param                                | Type             | Description                                                                |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------- |
| **boot_params**                      | *Object*         |
| **boot_platform**                    | *String*         | The platform image to be booted from on next boot                          |
| **current_platform**                 | *String*         | The platform image currently in use by server                              |
| **comments**                         | *String*         | Description of server                                                      |
| **created**                          | *String date*    | Date of server creation                                                    |
| **datacenter**                       | *String*         | Datacenter in which server resides                                         |
| **default_console**                  |                  |
| **disk_cores_quota_bytes**           |                  |
| **disk_installed_images_used_bytes** |                  |
| **disk_kvm_quota_bytes**             |                  |
| **disk_kvm_zvol_used_bytes**         |                  |
| **disk_kvm_zvol_volsize_bytes**      |                  |
| **disk_pool_size_bytes**             |                  |
| **disk_zone_quota_bytes**            |                  |
| **headnode**                         | *Boolean*        | Whether server is a headnode                                               |
| **hostname**                         | *String*         | Hostname of server if any                                                  |
| **kernel_flags**                     |                  |
| **last_boot**                        | *ISODate String* | Time of last boot
| **last_heartbeat**                   |                  | Timestamp indicating last-received heartbeat from compute node *DEPRECATED*
| **memory_arc_bytes**                 |                  |
| **memory_available_bytes**           |                  |
| **memory_provisionable_bytes**       |                  |
| **memory_total_bytes**               |                  |
| **overprovision_ratios**             |                  |
| **rack_identifier**                  |                  |
| **ram**                              | *Number*         | Amount of ram                                                              |
| **reservation_ratio**                |                  |
| **reserved**                         | *Boolean*        |                                                                            |
| **reservoir**                        | *Boolean*        |                                                                            |
| **serial**                           | *String*         |                                                                            |
| **setting_up**                       | *Boolean*        | Whether server is in the process of setting up                             |
| **setup**                            | *Boolean*        | Whether server has been marked as set up                                   |
| **status**                           | *String*         | Either 'running' or 'unknown' based on how recently CNAPI has heard from server |
| **sysinfo**                          | *Object*         | The last given sysinfo payload for server                                  |
| **traits**                           | *Object*         |                                                                            |
| **transitional_status**              | *String*         | This field is an implementation detail and should not be used in any way by CNAPI clients. It is exposed only for debugging. It is optional and may be: a string (currently only 'rebooting'), an empty string, or undefined |
| **unreserved_cpu**                   |                  |
| **unreserved_disk**                  |                  |
| **unreserved_ram**                   |                  |
| **uuid**                             | *String*         | The server's unique identifier                                             |
| **vms**                              | *Object*         | A object representing all the vms on server                                |


# Waitlist

Certain actions on datacenter resources require serialization of execution to
prevent undesireable or undefined results. Such actions include – but are not
limited to – DAPI allocation, VM lifecycle requests (creation, start, stop,
reboot, destroy), and dataset import. Waitlist should be used on any workflow
job where it is possible that concurrent jobs may interfere with each other if
actions on the compute node are not deconflicted by a system such as this.

Jobs should be grouped by the combination of [server_uuid, scope, id] and
serialized such that a server will only be executing one job per combination at
a time. In this way it would be possible to enforce that only one job be active
on a particular vm on a server, but would still allow jobs to be run against
another vm. Any jobs that come in after one is active will be queued and
dispatched as preceding jobs finish.

This system allows for concurrent jobs where the scoping has been set such
that two jobs will not interfere with each other. For instance, two reboot
jobs for two different vms may be run at the same time, however, two reboots
for the same vm will happen in sequential order.

Use of waitlist does not happen implicitly in workflow jobs. It is up to the
workflow job to create a ticket and wait for it to become active. As such, it
is possible to not use the waitlist at all. However, one then runs the risk of
concurrent jobs trampling each other.

Waitlist tickets are serialized and dispatched one by one according to their
`server_uuid`, `scope` and `id` parameters.

The first step to using the waitlist is to determine the scope and subject (ie
the resource on which the action will be performed). For example this may be
something like 'vm', 'dataset', etc.  This means that the action will be
performed on a resource identified by `id` of the type given by `scope`.

The basic process is as follows: a job starts and it first acquires a ticket
from CNAPI for that particular server and passes in a `scope` and an `id`.

Because waitlist tickets are serviced in creation order, once a ticket has been
created the next step is to wait for it to become active. Tickets become active
once all extant tickets for that server/scope/id are finished or expired.

To find out whether a ticket has become 'active' (i.e. indicating the job may
proceed and do its work), the job may poll the ticket values, or use the
blocking `wait` endpoint for that ticket.

Once the work has been completed, it is up to the job to "release" the ticket,
so that subsequent tickets for that scope/id combination can be serviced.

Acquiring a ticket before performing work is an explicit step (as opposed to
CNAPI doing the serialization internally) in effort to add transparency and to
know what is happening with the SDC pipeline from just looking at the
top-level workflow for some work to be performed.

### Request (create) a ticket

Using the waitlist begins with requesting a ticket. POST to the
CreateWaitlistTicket endpoint. Specify the scope and unique id. An expiry date
must also be specified. Endpoint returns a ticket uuid.

    -bash-4.1# sdc-cnapi /servers/$(sysinfo | json UUID)/tickets -X POST -d '{ "scope": "vm", "id": "nuts", "expires_at": "2015-10-10T00:00:00"}'
    HTTP/1.1 202 Accepted
    Content-Type: application/json
    Content-Length: 47
    Date: Fri, 27 Jun 2014 19:36:47 GMT
    Server: Compute Node API
    x-request-id: 60c72290-fe32-11e3-913f-b11ed03e831d
    x-response-time: 49
    x-server-name: 9d2c3229-1e92-4c3f-98fd-5a7ac5fb28ed
    Connection: keep-alive

    {
      "uuid": "ec8d5ef3-24b6-4582-ade8-c9e9bfb70906"
    }


### Display all tickets

    -bash-4.1# sdc-cnapi /servers/$(sysinfo | json UUID)/tickets
    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 260
    Date: Fri, 27 Jun 2014 19:37:12 GMT
    Server: Compute Node API
    x-request-id: 6fcc80a0-fe32-11e3-913f-b11ed03e831d
    x-response-time: 14
    x-server-name: 9d2c3229-1e92-4c3f-98fd-5a7ac5fb28ed
    Connection: keep-alive

    [
      {
        "uuid": "ec8d5ef3-24b6-4582-ade8-c9e9bfb70906",
        "server_uuid": "564d6e71-b375-4b81-07ec-ad77fe5fa680",
        "scope": "vm",
        "id": "nuts",
        "expires_at": "2015-10-10T00:00:00",
        "created_at": "2014-06-27T19:36:47.708Z",
        "updated_at": "2014-06-27T19:36:47.708Z",
        "status": "active"
      }
    ]

By default this endpoint will return 1000 tickets, sorted by creation time.
This endpoint supports the use of `limit` and `offset` parameters to allow one
to page through the results, with the caveat that the use of paging via `limit`
and `offset` does not guarantee that duplicates will not be seen.

Additionally, if `attribute` is passed in, overriding the value on which to
sort (creation time), it is possible that existing tickets may be missed from
the results list if tickets are deleted.


### Wait on a ticket

    -bash-4.1# sdc-cnapi /tickets/bb5038c2-7498-4e07-b919-df072c76d2dc/wait
    <returns when ticket is released or expires>


### Release a ticket

Releasing a ticket allows subsequent tickets (if any) queued on that
server/scope/id to become active.

    -bash-4.1# sdc-cnapi /tickets/bb5038c2-7498-4e07-b919-df072c76d2dc/release -X PUT
    HTTP/1.1 204 No Content
    Date: Fri, 27 Jun 2014 19:42:46 GMT
    Server: Compute Node API
    x-request-id: 3678cb00-fe33-11e3-913f-b11ed03e831d
    x-response-time: 19
    x-server-name: 9d2c3229-1e92-4c3f-98fd-5a7ac5fb28ed
    Connection: keep-alive


### Delete a ticket

Explicitly deletes a waitlist ticket. This will allow the next ticket in line
for the given scope/id to proceed. The next ticket waiting on the same scope/id
will be allowed to proceed.

    -bash-4.1# sdc-cnapi /tickets/ec8d5ef3-24b6-4582-ade8-c9e9bfb70906 -X DELETE
    HTTP/1.1 204 No Content
    Date: Fri, 27 Jun 2014 19:41:14 GMT
    Server: Compute Node API
    x-request-id: ff8dcd70-fe32-11e3-913f-b11ed03e831d
    x-response-time: 14
    x-server-name: 9d2c3229-1e92-4c3f-98fd-5a7ac5fb28ed
    Connection: keep-alive


<!-- Genererated API docs -->
# Allocation API

## SelectServer (POST /allocate)

Given the provided constraints, returns a server chosen to allocate a new VM,
as well as the steps taken to reach that decision. This does not cause the VM
to actually be created (see VmCreate for that), but rather returns the UUID
of an eligible server.

See DAPI docs for more details on how the vm, package, image and nic_tags
parameters must be constructed.

Be aware when inpecting steps output that the servers which are considered
for allocation must be both setup and unreserved. If a server you expected
does not turn up in steps output, its because the server didn't meet those
two criteria.

### Inputs

| Param    | Type   | Description                                                         |
| -------- | ------ | ------------------------------------------------------------------- |
| vm       | Object | Various required metadata for VM construction                       |
| package  | Object | Description of dimensions used to construct VM                      |
| image    | Object | Description of image used to construct VM                           |
| nic_tags | Array  | Names of nic tags which servers must have                           |
| servers  | Array  | Optionally limit which servers to consider by providing their UUIDs |


### Responses

| Code | Type   | Description                                    |
| ---- | ------ | ---------------------------------------------- |
| 200  | Object | Server selected and steps taken                |
| 409  | Object | No server found, and steps and reasons why not |
| 500  | Error  | Could not process request                      |


## ServerCapacity (POST /capacity)

Returns how much spare capacity there is on each server, specifically RAM
(in MiB), CPU (in percentage of CPU, where 100 = 1 core), and disk (in MiB).

This call isn't cheap, so it's preferable to make fewer calls, and restrict
the results to only the servers you're interested in by passing in the
desired servers' UUIDs.

### Inputs

| Param   | Type  | Description                                                         |
| ------- | ----- | ------------------------------------------------------------------- |
| servers | Array | Optionally limit which servers to consider by providing their UUIDs |


### Responses

| Code | Type   | Description                                 |
| ---- | ------ | ------------------------------------------- |
| 200  | Object | Server capacities and any associated errors |
| 500  | Error  | Could not process request                   |



# Boot Parameters API

## BootParamsGetDefault (GET /boot/default)

Returns the default boot parameters.

### Inputs

None.


### Responses

| Code | Type   | Description                             |
| ---- | ------ | --------------------------------------- |
| 200  | Object | Default boot parameters and kernel_args |
| 404  | None   | No such Server                          |


## BootParamsSetDefault (PUT /boot/default)

Set the default boot parameters.

Completely override the existing boot parameter values with the given
payload. Any values not present in the payload will effectively be deleted.

### Inputs

| Param           | Type   | Description                                  |
| --------------- | ------ | -------------------------------------------- |
| platform        | String | The platform image to use on next boot       |
| kernel_args     | Object | Key value pairs to be sent to server on boot |
| boot_modules    | Array  | List of boot module objects                  |
| kernel_flags    | Object | Kernel flags to be sent to server on boot    |
| serial          | Object | Serial device to use (i.e. "ttyb")           |
| default_console | Object | Default console type (i.e. "serial")         |


### Responses

| Code | Type | Description                       |
| ---- | ---- | --------------------------------- |
| 204  | None | Boot parameters successfully set. |
| 404  | None | No such Server                    |


## BootParamsUpdateDefault (POST /boot/default)

Modify the default boot parameters.

If a value is present in the default boot parameters, but no new value is
passed in, the currently effective value will remain unchanged.

### Inputs

| Param        | Type   | Description                           |
| ------------ | ------ | ------------------------------------- |
| kernel_args  | Object | Boot parms to update                  |
| boot_modules | Array  | List of boot module objects           |
| kernel_flags | Object | Kernel flags to update                |
| platform     | String | Set platform as the bootable platform |


### Responses

| Code | Type | Description                      |
| ---- | ---- | -------------------------------- |
| 204  | None | Boot parameters successfully set |
| 404  | None | No such Server                   |


## BootParamsGet (GET /boot/:server_uuid)

Returns the boot parameters for a particular server.

Returns the platform to be booted on the next reboot in addition to what
kernel parameters will be used to boot the server.

### Inputs

None.


### Responses

| Code | Type   | Description                             |
| ---- | ------ | --------------------------------------- |
| 200  | Object | Default boot parameters and kernel_args |
| 404  | None   | No such Server                          |


## BootParamsSet (PUT /boot/:server_uuid)

Set the boot parameters of a server.

Completely overrides the platform and boot parameters of a server. If a
value is not set in the new object but is in the old one, it will be
effectively deleted when the new object replaces the old.

### Inputs

| Param           | Type   | Description                           |
| --------------- | ------ | ------------------------------------- |
| kernel_args     | Object | Boot parms to update                  |
| boot_modules    | Array  | List of boot module objects           |
| kernel_values   | Object | Kernel flags to update                |
| platform        | String | Set platform as the bootable platform |
| serial          | Object | Serial device to use (i.e. "ttyb")    |
| default_console | Object | Default console type (i.e. "serial")  |


### Responses

| Code | Type | Description    |
| ---- | ---- | -------------- |
| 202  | None | No content     |
| 404  | None | No such Server |


## BootParamsUpdate (POST /boot/:server_uuid)

Update only the given boot configuration values.

Does not overwrite any values which are not given.

### Inputs

| Param        | Type   | Description                           |
| ------------ | ------ | ------------------------------------- |
| kernel_args  | Object | Boot parms to update                  |
| kernel_flags | Object | Hash containing flag key/value pairs  |
| boot_modules | Array  | List of boot module objects           |
| platform     | String | Set platform as the bootable platform |


### Responses

| Code | Type | Description |
| ---- | ---- | ----------- |
| 202  | None | No content  |



# Compute Node Agent Tasks API

## TaskGet (GET /tasks/:task_id)

Returns the details of the given task.

### Inputs

None.


### Responses

| Code | Type   | Description        |
| ---- | ------ | ------------------ |
| 200  | Object | Task details       |
| 404  | None   | No such task found |


## TaskWait (GET /tasks/:task_id/wait)

Waits for a given task to return or an expiry to be reached.

### Inputs

None.


### Responses

| Code | Type   | Description        |
| ---- | ------ | ------------------ |
| 200  | Object | Task details       |
| 404  | None   | No such task found |



# Miscellaneous API

## ImageGet (GET /servers/:server_uuid/images/:uuid)

Query the server for the Image's details.

### Inputs

| Param | Type   | Description                               |
| ----- | ------ | ----------------------------------------- |
| jobid | String | Post information to workflow with this id |


### Responses

| Code | Type   | Description       |
| ---- | ------ | ----------------- |
| 200  | Object | Request succeeded |
| 404  | Object | No such Image     |
| 404  | Object | No such server    |


## Ping (GET /ping)

Return CNAPI's service status details.

### Inputs

None.


### Responses

| Code | Type   | Description     |
| ---- | ------ | --------------- |
| 200  | Object | Status details. |


## NicUpdate (PUT /servers/:server_uuid/nics)

Modify the target server's nics.

The only parameter of the server's nics that can be changed is
nic_tags_provided. This parameter can be changed depending on the following
values for the *action* parameter:

* update: Add nic tags to the target nics
* replace: Replace the nic tags (ie: completely overwrite the list) for the
  target nics
* delete: Remove the nic tags from the target nics

For examples, see the [Updating Nics](#updating-nics) section above.

As per the [Updating Nics](#updating-nics) section above, the **nics**
parameter must be an array of objects. Those objects must have both the
**mac** and **nic_tags_provided** properties.

### Inputs

| Param  | Type   | Description                                  |
| ------ | ------ | -------------------------------------------- |
| action | String | Nic action: 'update', 'replace' or 'delete'. |
| nics   | Object | Array of nic objects.                        |


### Responses

| Code | Type  | Description                         |
| ---- | ----- | ----------------------------------- |
| 202  | None  | Workflow was created to modify nics |
| 404  | Error | No such server                      |


## PlatformList (GET /platforms)

Returns available platform images in datacenter.

### Inputs

None.


### Responses

| Code | Type  | Description          |
| ---- | ----- | -------------------- |
| 200  | Array | The returned servers |



# Remote Execution API (deprecated)

## CommandExecute (deprecated) (POST /servers/:server_uuid/execute)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. It exists only for backward compatibility and should not be used for
any new development. If you wish to execute commands on a CN, this should be
done through a new cn-agent task, or a new agent.*

Synchronously execute a command on the target server.

If `json` is true, the result returned will be a JSON object with `stdout`,
`stderr` and `exitCode` properties. If the json flag is not passed or not set
true, the body of the response will contain only the stdout and if the script
executed non-zero a 500 error will be returned.

### Inputs

| Param   | Type    | Description                                                                                                                                                  |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| args    | Array   | Array containing arguments to be passed in to command                                                                                                        |
| env     | Object  | Object containing environment variables to be passed in                                                                                                      |
| script  | String  | Script to be executed. Must have a shebang line                                                                                                              |
| json    | Boolean | Whether to return results as JSON instead of just stdout (default = false)                                                                                   |
| timeout | Integer | Number of ms to wait for command completion before killing task and returning (only supported when using cn-agent, See: FEATURE_USE_CNAGENT_COMMAND_EXECUTE) |


### Responses

| Code | Type | Description                     |
| ---- | ---- | ------------------------------- |
| 404  | None | No such server                  |
| 500  | None | Error occurred executing script |



# Server API

## ServerList (GET /servers)

Returns Servers present in datacenter.

### Inputs

| Param     | Type    | Description                                                                                                               |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| uuids     | String  | Comma seperated list of UUIDs to look up                                                                                  |
| setup     | Boolean | Return only setup servers                                                                                                 |
| headnode  | Boolean | Return only headnodes                                                                                                     |
| reserved  | Boolean | Return only reserved servers                                                                                              |
| reservoir | Boolean | Return only reservoir servers                                                                                             |
| hostname  | String  | Return machine with given hostname                                                                                        |
| extras    | String  | Comma seperated values: agents, vms, memory, disk, sysinfo, capacity, all                                                 |
| limit     | Integer | Maximum number of results to return. It must be between 1-1000, inclusive. Defaults to 1000 (the maxmimum allowed value). |
| offset    | Integer | Offset the subset of results returned                                                                                     |


### Responses

| Code | Type  | Description          |
| ---- | ----- | -------------------- |
| 200  | Array | The returned servers |


## ServerGet (GET /servers/:server\_uuid)

Look up a single Server by UUID.

### Inputs

None.


### Responses

| Code | Type   | Description       |
| ---- | ------ | ----------------- |
| 200  | Object | The server object |


## ServerUpdate (POST /servers/:server_uuid)

Set the value of a Server's attribute.

### Inputs

| Param                | Type    | Description                                                                                                                                                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agents               | Array   | Array of agents present on this server                                                                                                                                                                         |
| boot_platform        | String  | The platform image to be used on next boot                                                                                                                                                                     |
| default_console      | String  | Console type                                                                                                                                                                                                   |
| etag_retries         | Number  | number of times to retry update in case of ETag conflict                                                                                                                                                       |
| rack_identifier      | String  | The id of the server's rack                                                                                                                                                                                    |
| comments             | String  | Any comments about the server                                                                                                                                                                                  |
| next_reboot          | String  | ISO timestamp when next reboot is scheduled for                                                                                                                                                                |
| nics                 | Array   | List of NICs to update (see `Updating NICs` section)                                                                                                                                                           |
| reserved             | Boolean | Server is available for provisioning                                                                                                                                                                           |
| reservoir            | Boolean | Server should be considered last for provisioning                                                                                                                                                              |
| reservation_ratio    | Number  | The reservation ratio                                                                                                                                                                                          |
| overprovision_ratios | Object  | The overprovisioning ratios. Must be an object with Number value keys and keys must be one of 'cpu', 'ram', 'disk', 'io', 'net'.                                                                               |
| serial               | String  | Serial device                                                                                                                                                                                                  |
| setup                | Boolean | True if server has been set up                                                                                                                                                                                 |
| setting_up           | Boolean | True if server is in the process of setting up                                                                                                                                                                 |
| transitional_status  | String  | A value to use to override status when the server has status 'unknown'. This is for internal use only and currently is only used by server-reboot to set the state to 'rebooting' while a server is rebooting. |
| traits               | Object  | Server traits                                                                                                                                                                                                  |


### Responses

| Code | Type | Description                   |
| ---- | ---- | ----------------------------- |
| 204  | None | The value was set successfuly |


## ServerReboot (POST /servers/:server\_uuid/reboot)

Reboot the server.

### Inputs

| Param        | Type    | Description                                                                                                   |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------- |
| origin       | String  |                                                                                                               |
| creator_uuid | String  |                                                                                                               |
| drain        | Boolean | Wait for server's cn-agent to be drained before sending the reboot command                                    |
| nojob        | Boolean | If true, don't create a workflow job, but instead talk to the server_reboot task in cn-agent (default: false) |


### Responses

| Code | Type   | Description                                                                             |
| ---- | ------ | --------------------------------------------------------------------------------------- |
| 202  | Object | Server reboot initiated (object with job_uuid is returned)                              |
| 204  | None   | Server reboot initiated                                                                 |
| 500  | None   | Error attempting to set up server                                                       |
| 503  | None   | When nojob=true, this means the server does not support the server_reboot cn-agent task |


## ServerFactoryReset (PUT /servers/:server\_uuid/factory-reset)

Reset the server back to a factory state.

### Inputs

None.


### Responses

| Code | Type   | Description                                           |
| ---- | ------ | ----------------------------------------------------- |
| 204  | Object | Setup initated, returns object containing workflow id |
| 500  | None   | Error attempting to set up server                     |


## ServerSetup (PUT /servers/:server_uuid/setup)

Initiate the server setup process for a newly started server.

### Inputs

| Param            | Type   | Description                                                  |
| ---------------- | ------ | ------------------------------------------------------------ |
| nics             | Object | Nic parameters to update                                     |
| postsetup_script | String | Script to run after setup has completed                      |
| hostname         | String | Hostname to set for the specified server                     |
| disk_spares      | String | See `man disklayout` spares                                  |
| disk_width       | String | See `man disklayout` width                                   |
| disk_cache       | String | See `man disklayout` cache                                   |
| disk_layout      | String | See `man disklayout` type      (single, mirror, raidz1, ...) |


### Responses

| Code | Type   | Description                                           |
| ---- | ------ | ----------------------------------------------------- |
| 200  | Object | Setup initated, returns object containing workflow id |
| 500  | None   | Error while processing request                        |


## ServerSysinfoRegister (POST /servers/:server_uuid/sysinfo)

Register a given server's sysinfo values and store them in the server object.
Does the same thing as CNAPI receiving a sysinfo message via Ur. This means
that if you post sysinfo for a non-existent server, a server record will be
created.

IMPORTANT: This endpoint is only intended to be used by cn-agent. Any other
use will not be supported and may break in the future.

### Inputs

| Param   | Type   | Description     |
| ------- | ------ | --------------- |
| sysinfo | Object | Sysinfo Object. |


### Responses

| Code | Type | Description                    |
| ---- | ---- | ------------------------------ |
| 200  | None | Sysinfo registration initiated |
| 500  | None | Error while processing request |


## ServerSysinfoRefresh (deprecated) (POST /servers/:server_uuid/sysinfo-refresh)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. It exists only for backward compatibility and should not be used for
any new development. As of version 2.9.0, cn-agent will keep the sysinfo
up-to-date, so there's no need to call this.*

Fetch a given server's sysinfo values and store them in the server object.

### Inputs

None.


### Responses

| Code | Type   | Description                    |
| ---- | ------ | ------------------------------ |
| 200  | Object | Sysinfo refresh initiated      |
| 500  | None   | Error while processing request |


## ServerDelete (DELETE /servers/:server_uuid)

Remove all references to given server. Does not change anything on the
actual server.

### Inputs

None.


### Responses

| Code | Type  | Description                     |
| ---- | ----- | ------------------------------- |
| 204  | None  | Server was deleted successfully |
| 500  | Error | Could not process request       |


## ServerTaskHistory (GET /servers/:server_uuid/task-history)

Return details of most recent cn-agent tasks run on the compute node since
cn-agent was started.

### Inputs

None.


### Responses

| Code | Type  | Description                 |
| ---- | ----- | --------------------------- |
| 200  | Ok    | Tasks returned successfully |
| 500  | Error | Could not process request   |


## ServerPauseCnAgent (GET /servers/:server_uuid/cn-agent/pause)

Makes cn-agent stop accepting new tasks

### Inputs

None.


### Responses

| Code | Type  | Description               |
| ---- | ----- | ------------------------- |
| 204  | No    | Content on success        |
| 500  | Error | Could not process request |


## ServerResumeCnAgent (GET /servers/:server_uuid/cn-agent/resume)

Makes cn-agent accept new tasks

Note this is the default behavior and this end-point is useful
only after a previous call to ServerPauseCnAgent

### Inputs

None.


### Responses

| Code | Type  | Description               |
| ---- | ----- | ------------------------- |
| 204  | No    | Content on success        |
| 500  | Error | Could not process request |


## ServerEnsureImage (GET /servers/:server_uuid/ensure-image)

Assert an image is present on a compute node and ready for use in
provisioning. If this is not the case, fetch and install the image onto the
compute node zpool.

### Inputs

| Param                 | Type   | Description                     |
| --------------------- | ------ | ------------------------------- |
| image_uuid            | String | UUID of image to install        |
| zfs_storage_pool_name | String | zpool on which to install image |


### Responses

| Code | Type  | Description                 |
| ---- | ----- | --------------------------- |
| 204  | None  | Tasks returned successfully |
| 500  | Error | Could not process request   |


## ServerInstallAgent (POST /servers/:server_uuid/install-agent)

Instruct server to install given agent. Pass in image uuid of package to
install and server will download and install package.

### Inputs

| Param        | Type   | Description              |
| ------------ | ------ | ------------------------ |
| image_uuid   | String | UUID of image to install |
| package_name | String | Package name             |
| package_file | String | Package file             |


### Responses

| Code | Type  | Description                         |
| ---- | ----- | ----------------------------------- |
| 200  | Ok    | Install task initiated successfully |
| 500  | Error | Could not process request           |


## ServerUninstallAgents (POST /servers/:server_uuid/uninstall-agents)

Uninstall the given agents on the server.
(Requires cn-agent v2.8.0 or later.)

### Inputs

| Param  | Type  | Description                                                                                                                                       |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| agents | Array | The names of the agents to uninstall. Passing      "cn-agent" as an agent to remove results in undefined (and likely      destructive) behaviour. |


### Responses

| Code | Type  | Description                                                                  |
| ---- | ----- | ---------------------------------------------------------------------------- |
| 200  | Ok    | Uninstall task created successfully                                          |
| 412  | Error | PreconditionFailed if the target server has a cn-agent      that is too old. |
| 500  | Error | Could not process request                                                    |



# Virtual Machine API

## VmList (GET /servers/:server_uuid/vms)

(DEPRECATED: use VMAPI instead)

Query the server for a list of VMs.

### Inputs

None.


### Responses

| Code | Type   | Description    |
| ---- | ------ | -------------- |
| 204  | Array  | List of VMs    |
| 404  | Object | No such server |


## VmLoad (GET /servers/:server_uuid/vms/:uuid)

Query the server for the VM's details.

### Inputs

| Param       | Type    | Description                                   |
| ----------- | ------- | --------------------------------------------- |
| jobid       | String  | Post information to workflow with this id     |
| include_dni | Boolean | Allow a VM with the do_not_inventory flag set |


### Responses

| Code | Type   | Description             |
| ---- | ------ | ----------------------- |
| 204  | Object | Task was sent to server |
| 404  | Object | No such VM              |
| 404  | Object | No such server          |


## VmInfo (GET /servers/:server_uuid/vms/:uuid/info)

Query the server for the VM's `vmadm info` output.

### Inputs

None.


### Responses

| Code | Type   | Description       |
| ---- | ------ | ----------------- |
| 200  | Object | Request succeeded |
| 404  | Object | No such VM        |
| 404  | Object | No such server    |


## VmInfo (GET /servers/:server_uuid/vms/:uuid/vnc)

Query the server for the VM's VNC host and port.

### Inputs

None.


### Responses

| Code | Type   | Description       |
| ---- | ------ | ----------------- |
| 200  | Object | Request succeeded |
| 404  | Object | No such VM        |
| 404  | Object | No such server    |


## VmUpdate (POST /servers/:server\_uuid/vms/:uuid/update)

Modify the system parameters of the VM identified by `:uuid` on server with
UUID `:server_uuid`.

### Inputs

| Param | Type   | Description                               |
| ----- | ------ | ----------------------------------------- |
| jobid | String | Post information to workflow with this id |


### Responses

| Code | Type  | Description             |
| ---- | ----- | ----------------------- |
| 204  | None  | Task was sent to server |
| 404  | Error | No such VM              |
| 404  | Error | No such server          |


## VmNicsUpdate (POST /servers/:server\_uuid/vms/nics/update)

Bulk modify VM nics

### Inputs

| Param | Type   | Description                               |
| ----- | ------ | ----------------------------------------- |
| jobid | String | Post information to workflow with this id |


### Responses

| Code | Type  | Description                  |
| ---- | ----- | ---------------------------- |
| 204  | None  | Task was sent to server      |
| 400  | Error | Task not supported on server |
| 404  | Error | No such server               |


## VmStart (POST /servers/:server_uuid/vms/:uuid/start)

Boot up a vm which is in the 'stopped' state.

### Inputs

| Param | Type   | Description                               |
| ----- | ------ | ----------------------------------------- |
| jobid | String | Post information to workflow with this id |


### Responses

| Code | Type  | Description             |
| ---- | ----- | ----------------------- |
| 204  | None  | Task was sent to server |
| 404  | Error | No such VM              |
| 404  | Error | No such server          |


## VmStop (POST /servers/:server\_uuid/vms/:uuid/stop)

Shut down a VM which is in the 'running' state.

### Inputs

| Param | Type   | Description                               |
| ----- | ------ | ----------------------------------------- |
| jobid | String | Post information to workflow with this id |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such VM                                            |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmKill (POST /servers/:server_uuid/vms/:uuid/kill)

Send a signal to a given VM.

### Inputs

| Param  | Type   | Description                                    |
| ------ | ------ | ---------------------------------------------- |
| jobid  | String | Post information to workflow with this id      |
| signal | String | Optional: Signal to send to init process of VM |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmReboot (POST /servers/:server\_uuid/vms/:uuid/reboot)

Reboot a VM which is in the 'running' state.

### Inputs

| Param | Type   | Description                               |
| ----- | ------ | ----------------------------------------- |
| jobid | String | Post information to workflow with this id |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such VM                                            |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmCreate (POST /servers/:server_uuid/vms)

Create a VM on the specified server.

### Inputs

| Param | Type   | Description                                      |
| ----- | ------ | ------------------------------------------------ |
| jobid | String | Create a new virtual machine on the given server |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmReprovision (POST /servers/:server_uuid/vms/:uuid/reprovision)

Reprovision a given VM.

### Inputs

| Param      | Type   | Description                                      |
| ---------- | ------ | ------------------------------------------------ |
| jobid      | String | Create a new virtual machine on the given server |
| image_uuid | String | Reprovision using the new image_uuid             |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmDestroy (DELETE /servers/:server_uuid/vms/:uuid)

Delete the specified VM.

### Inputs

None.


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmDockerExec (POST /servers/:server\_uuid/vms/:uuid/docker-exec)

Send a docker_exec task to the given server/vm. This starts a server on the
given server which will spawn a process with the given docker payload.

### Inputs

| Param   | Type   | Description                                      |
| ------- | ------ | ------------------------------------------------ |
| address | String | ip:port where the stdio server will be listening |
| host    | String | host where the stdio server will be listening    |
| port    | Number | port on host the stdio server will be listening  |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such VM                                            |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmDockerCopy (POST /servers/:server\_uuid/vms/:uuid/docker-copy)

Send a docker_copy task to the given server/vm. This starts a temporary
service on the given server which will stream the the requested file.

### Inputs

| Param   | Type   | Description                                      |
| ------- | ------ | ------------------------------------------------ |
| address | String | ip:port where the stdio server will be listening |
| host    | String | host where the stdio server will be listening    |
| port    | Number | port on host the stdio server will be listening  |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such VM                                            |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmDockerStats (POST /servers/:server\_uuid/vms/:uuid/docker-stats)

Send a docker_stats task to the given server/vm. This starts a temporary
service on the given server which will stream back the container stats.

### Inputs

| Param   | Type   | Description                                      |
| ------- | ------ | ------------------------------------------------ |
| address | String | ip:port where the stdio server will be listening |
| host    | String | host where the stdio server will be listening    |
| port    | Number | port on host the stdio server will be listening  |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such VM                                            |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmDockerBuild (POST /servers/:server\_uuid/vms/:uuid/docker-build)

Send a docker_build task to the given server/vm. This starts a temporary
service on the given server which will allow streaming of the build context
to the server and then runs the docker build steps.

### Inputs

None.


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |



# Virtual Machine Images API

## VmImagesCreate (POST /servers/:server_uuid/vms/:uuid/images)

Create a VM image.

### Inputs

| Param                | Type    | Description                                                                                                                                                             |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| jobid                | String  | Create a new virtual machine on the given server                                                                                                                        |
| compression          | String  | Compression to use for creating image                                                                                                                                   |
| imgapi_url           | String  | Location of imgapi                                                                                                                                                      |
| incremental          | Boolean | Make this an incremental image? Optional.      Default is false.                                                                                                        |
| prepare_image_script | String  | A script run in a reboot of the VM      to prepare it for imaging.                                                                                                      |
| manifest             | Object  | Image manifest object. Require at least "uuid",      "owner", "name" and "version" keys. See "imgadm create"      documentation for other required and optional fields. |


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |



# Virtual Machine Snapshots API

## VmSnapshotCreate (PUT /servers/:server_uuid/vms/:uuid/snapshots)

Task a snapshot of a VM.

### Inputs

None.


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmSnapshotRollback (PUT /servers/:server_uuid/vms/:uuid/snapshots/:snapshot_name/rollback)

Roll back to a previous snapshot of a VM.

### Inputs

None.


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |


## VmSnapshotDestroy (DELETE /servers/:server_uuid/vms/:uuid/snapshots/:snapshot_name)

Delete a VM's snapshot.

### Inputs

None.


### Responses

| Code | Type  | Description                                           |
| ---- | ----- | ----------------------------------------------------- |
| 204  | None  | Task was sent to server                               |
| 404  | Error | No such server                                        |
| 500  | Error | Error encountered while attempting to fulfill request |



# Waitlist API

## ServerWaitlistList (GET /servers/:server_uuid/tickets)

Returns all waitlist tickets currently active on a server. Returns the uuid of
the newly created ticket as well as an array of all the tickets in the ticket's
scope queue. By default servers are returned in the chronological order of their
creation (`created_at` timestamp). By default the responses are limited to 1000
results. Use the `limit` and `offset` to page through results.

### Inputs

| Param      | Type   | Description                              |
| ---------- | ------ | ---------------------------------------- |
| limit      | Number | Return at most this many results         |
| offset     | Number | Return results starting at this position |
| attribhute | String | Attribute to sort on                     |
| order      | String | Sort in 'DESC' or 'ASC' order            |


### Responses

| Code | Type  | Description                    |
| ---- | ----- | ------------------------------ |
| 200  | Array | Waitlist returned successfully |
| 500  | Error | Could not process request      |


## ServerWaitlistTicketCreate (POST /servers/:server_uuid/tickets)

Create a new waitlist ticket.

### Inputs

| Param      | Type   | Description                                  |
| ---------- | ------ | -------------------------------------------- |
| scope      | String | Limit the ticket to the given scope          |
| id         | String | The id of the resource of type 'scope'       |
| expires_at | String | ISO 8601 date string when ticket will expire |
| action     | String | Description of acting to be undertaken       |
| extra      | Object | Object containing client specific metadata   |


### Responses

| Code | Type  | Description                          |
| ---- | ----- | ------------------------------------ |
| 202  | Array | Waitlist ticket created successfully |
| 500  | Error | Could not process request            |


## ServerWaitlistGetTicket (POST /tickets/:ticket_uuid)

Retrieve a waitlist ticket.

### Inputs

None.


### Responses

| Code | Type  | Description                           |
| ---- | ----- | ------------------------------------- |
| 200  | Array | Waitlist ticket returned successfully |
| 500  | Error | Could not process request             |


## ServerWaitlistDeleteTicket (DELETE /tickets/:ticket_uuid)

Delete a waitlist ticket.

### Inputs

None.


### Responses

| Code | Type  | Description                          |
| ---- | ----- | ------------------------------------ |
| 204  | Array | Waitlist ticket deleted successfully |
| 500  | Error | Could not process request            |


## ServerWaitlistTicketsDeleteAll (DELETE /servers/:server_uuid/tickets)

Delete all of a server's waitlist tickets.

### Inputs

| Param | Type    | Description                                 |
| ----- | ------- | ------------------------------------------- |
| force | Boolean | Must be set to 'true' for delete to succeed |


### Responses

| Code | Type  | Description                          |
| ---- | ----- | ------------------------------------ |
| 204  | Array | Waitlist ticket deleted successfully |
| 500  | Error | Could not process request            |


## ServerWaitlistTicketsWait (GET /tickets/:ticket_uuid/wait)

Wait until a waitlist ticket either expires or becomes active.

### Inputs

None.


### Responses

| Code | Type  | Description               |
| ---- | ----- | ------------------------- |
| 204  | Array | Ticket active or expired  |
| 500  | Error | Could not process request |


## ServerWaitlistTicketsRelease (GET /tickets/:ticket_uuid/release)

Release a currently active or queued waitlist ticket.

### Inputs

None.


### Responses

| Code | Type  | Description                  |
| ---- | ----- | ---------------------------- |
| 204  | Array | Ticket released successfully |
| 500  | Error | Could not process request    |



# ZFS API (deprecated)

## DatasetsList (GET /servers/:server_uuid/datasets)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

List ZFS datasets on a server.

### Inputs

None.


### Responses

| Code | Type  | Description                                 |
| ---- | ----- | ------------------------------------------- |
| 200  | Array | Array of objects, one per dataset on server |


## DatasetCreate (POST /servers/:server_uuid/datasets)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

Create a ZFS dataset on a server.

### Inputs

None.


### Responses

| Code | Type | Description                  |
| ---- | ---- | ---------------------------- |
| 204  | None | Dataset successfully created |


## SnapshotCreate (POST /servers/:server_uuid/datasets/:dataset/snapshot)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

Create a ZFS snapshot of a dataset on a server.

### Inputs

| Param | Type   | Description                        |
| ----- | ------ | ---------------------------------- |
| name  | String | The name of the snapshot to create |


### Responses

| Code | Type | Description                   |
| ---- | ---- | ----------------------------- |
| 204  | None | Snapshot successfully created |


## SnapshotRollback (POST /servers/:server_uuid/datasets/:dataset/rollback)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

Revert a ZFS dataset to back to a previous state captured by a snapshot.

### Inputs

| Param | Type   | Description                            |
| ----- | ------ | -------------------------------------- |
| name  | String | The name of the snapshot to be created |


### Responses

| Code | Type | Description                       |
| ---- | ---- | --------------------------------- |
| 204  | None | Snapshot successfully rolled back |


## SnapshotList (GET /servers/:server_uuid/datasets/:dataset/snapshots)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

List all snapshots on a dataset

### Inputs

None.


### Responses

| Code | Type  | Description               |
| ---- | ----- | ------------------------- |
| 200  | Array | Array of snapshot objects |


## DatasetPropertiesGetAll (GET /servers/:server_uuid/dataset-properties)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

Get ZFS properties across all datasets on a server.

### Inputs

| Param   | Type   | Description                                 |
| ------- | ------ | ------------------------------------------- |
| <prop1> | String | Get the property given by the "prop1" value |
| <prop2> | String | Get the property given by the "prop2" value |
| <propN> | String | Get the property given by the "propN" value |


### Responses

| Code | Type   | Description              |
| ---- | ------ | ------------------------ |
| 200  | Object | list of property details |


## DatasetPropertiesGet (GET /servers/:server_uuid/datasets/:dataset/properties)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

Get ZFS properties for a dataset.  The specific properties to return can be
filtered with ?prop1=foo&prop2=bar, etc.

### Inputs

| Param   | Type   | Description                                 |
| ------- | ------ | ------------------------------------------- |
| <prop1> | String | Get the property given by the "prop1" value |
| <prop2> | String | Get the property given by the "prop2" value |
| <propN> | String | Get the property given by the "propN" value |


### Responses

| Code | Type  | Description                      |
| ---- | ----- | -------------------------------- |
| 200  | Array | List of dataset property details |


## DatasetPropertiesSet (POST /servers/:server_uuid/datasets/:dataset/properties)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

Set one or more properties for a ZFS dataset.

### Inputs

| Param      | Type   | Description                              |
| ---------- | ------ | ---------------------------------------- |
| properties | Object | Object containing string property values |


### Responses

| Code | Type | Description                      |
| ---- | ---- | -------------------------------- |
| 204  | None | Properties were set successfully |


## DatasetDestroy (DELETE /servers/:server_uuid/datasets/:dataset)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

Destroy a ZFS dataset on a server.

### Inputs

None.


### Responses

| Code | Type | Description                  |
| ---- | ---- | ---------------------------- |
| 204  | None | Dataset successfully deleted |


## ZpoolList (GET /servers/:server_uuid/zpools)

*IMPORTANT: This endpoint is deprecated and will be removed in a future
release. Do not use.*

List the ZFS pools on a server.

### Inputs

None.


### Responses

| Code | Type  | Description                  |
| ---- | ----- | ---------------------------- |
| 200  | Array | List of zpool detail objects |





<!-- End of genererated API docs -->
