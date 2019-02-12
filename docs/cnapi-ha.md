<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2019, Joyent, Inc.
-->

# CNAPI High Availability

CNAPI occupies an critical position within the hiearchy of the SDC service
stack, and as such, losing either the service, or the server (the headnode) it
resides on would be devastating to the state of the datacentre. Therefore, being
able to run multiple instances of CNAPI is of the utmost importance.

Should the situation arise where a critical service experiences a problem, it
is advantageous to have redundant instances to fail-over onto. Running multiple
instances of a service accross different physical servers limits the possible
risk should one of those servers experience software, hardware or network
faults.


# Mechanics

<img src="cnapi-ha.png" />


When any CNAPI instance starts up, it will connect to the `ur.cnapi` queue. It
will then bind to this queue the routing key `ur.sysinfo.#`. When a compute node
comes online, it will broadcast a message to a `ur.sysinfo.#`.  Unsetup compute
nodes will periodically emit `ur.sysinfo` messages after that to alert any
listening CNAPI instances that the server exists, even though it may not yet
have agents installed.

Due to the nature of AMQP, when multiple consumers are connected to a single
queue, the expected behaviour is round-robin distribution of messages amongst
connected consumers. If one CNAPI instance gets a startup or sysinfo message it
is its responsibility to write that data to Moray and take any necessary action
on it.


#### 1

Provisioner starts up and resolves `cnapi.${datacenter_name}.${dns_domain}` to
an IP address for one CNAPI instances. Each provisioner is directed to a
particular CNAPI instance which will be responsible for keeping the state of
that compute node up to date in moray.


#### 2

Provisioner opens a persistent HTTP connection to the given CNAPI. Provisioner
sends its current VM state. The presence of this connection indicates to CNAPI
that the server is up and "running". Provision and CNAPI will both periodically
send a little bit of data to ensure the connection is still alive. If
provisioner at any point loses its connection to CNAPI it will retry to
connect. If it cannot reach CNAPI it will look up a new CNAPI ip-address via
DNS and attempt to connect to it.

Question: should it try to reconnect to the same CNAPI or try for a new one?


#### 3

Provisioner begins to broadcast a stream of VM events via AMQP. APIs which
require an up-to-date picture of the compute node, create a queue and bind it
to messages originating from a paricular compute node or all compute nodes (in
the case of VMAPI).


#### 4

By looking up a compute node's ip-address in Moray, any CNAPI instance may
contact via HTTP any provisioner in the datancenter to initiate provisioner
tasks. Task information and state is stored in moray and should be readable by
any CNAPI instance.


#### 5

When a new provisioner connects to CNAPI, CNAPI persists the current state to
moray. Additionally, CNAPI will listen for AMQP messages from that particular
server. These messages will consist of events such as vm creation or
destruction, vm state changes, quota changes, etc.


#### 6

A client may connect to any CNAPI instance to request server information or to
initiate Ur or provisioner requests.
