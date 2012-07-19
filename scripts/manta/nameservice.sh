#!/bin/bash

set -o xtrace

PATH=/opt/smartdc/binder/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH

ZOOKEEPER_CONFIG=/opt/local/etc/zookeeper/zoo.cfg
ZOOKEEPER_ID=/var/db/zookeeper/myid

function fatal
{
    echo "$(basename $0): fatal error: $*"
    exit 1
}

function update_zk_cfg {
    local zk_ips
    zk_ips=$(mdata-get nameserver_ips)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve nameserver_ips from metadata"
    local my_ip
    my_ip=$(mdata-get sdc:nics.0.ip)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve our own IP address"

    echo "Our IP=$my_ip; All ZooKeeper IPs=$zk_ips"

    echo "Generating zoo.cfg"
    cat > $ZOOKEEPER_CONFIG <<HERE
# The number of milliseconds of each tick
tickTime=2000
# The number of ticks that the initial
# synchronization phase can take
initLimit=10
# The number of ticks that can pass between
# sending a request and getting an acknowledgement
syncLimit=5
dataDir=/var/db/zookeeper
# the port at which the clients will connect
clientPort=2181
HERE

    local n=1
    for ip in $zk_ips; do
	echo server.$n=$ip:2888:3888 >>$ZOOKEEPER_CONFIG
	n=$(( $n + 1 ))
    done

    rm -f /var/db/zookeeper/myid
    grep $my_ip $ZOOKEEPER_CONFIG | cut -c 8 > $ZOOKEEPER_ID
}


function update_env {
    echo "" >>/root/.bashrc
    echo "export PATH=\$PATH:/opt/smartdc/binder/build/node/bin:/opt/smartdc/binder/node_modules/.bin" >>/root/.bashrc
}


# Mainline

echo "Updating ZooKeeper configuration"
update_zk_cfg

echo "Updating ~/.bashrc"
update_env

svccfg import /opt/local/share/smf/zookeeper-server/manifest.xml
svcadm enable zookeeper

svccfg import /opt/smartdc/binder/smf/manifests/binder.xml
svcadm enable binder

exit 0
