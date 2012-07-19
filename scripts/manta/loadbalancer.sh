#!/bin/bash

set -o xtrace

MUPPET_CFG=/opt/smartdc/muppet/etc/config.json
PATH=/opt/smartdc/muppet/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH
REGISTRAR_CFG=/opt/smartdc/registrar/etc/config.json

function fatal
{
    echo "$(basename $0): fatal error: $*"
    exit 1
}

function update_dns {
    local domain_name
    local nameservers
    domain_name=$(mdata-get service_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve our domain name from metadata"
    nameservers=$(mdata-get nameservers)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve nameservers from metadata"

    echo domain $domain_name > /etc/resolv.conf
    for ip in $nameservers
    do
        echo nameserver $ip >> /etc/resolv.conf
    done
}


function update_env {
    echo "" >>/root/.bashrc
    echo "export PATH=\$PATH:/opt/smartdc/registrar/build/node/bin:/opt/smartdc/registrar/node_modules/.bin" >>/root/.bashrc
}


function update_muppet {
    local svc_name
    local zk_ips
    svc_name=$(mdata-get service_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve service name"
    zk_ips=$(mdata-get nameservers)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve nameservers from metadata"

    echo "Generating muppet.cfg"
    cat > $MUPPET_CFG <<HERE
{
        "name": "$svc_name",
        "srvce": "_http",
        "proto": "_tcp",
        "port": 80,
        "zookeeper": {
                "servers": [],
                "timeout": 1000
        }
}
HERE

    for ip in $zk_ips
    do
        cat $MUPPET_CFG | \
            json -e "zookeeper.servers.push({ host: \\"$ip\\", port: 2181 });" \
            > /tmp/.muppet.json

	mv /tmp/.muppet.json $MUPPET_CFG
    done
}


function update_registrar {
    local my_ip
    local svc_name
    local zk_ips

    my_ip=$(mdata-get sdc:nics.0.ip)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve our own IP address"
    svc_name=$(mdata-get service_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve service name"
    zk_ips=$(mdata-get nameservers)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve nameservers from metadata"

    echo "Generating registrar.cfg"
    cat > $REGISTRAR_CFG <<HERE
{
        "registration": {
                "domain": "$svc_name",
                "type": "load_balancer",
                "service": {
                        "type": "service",
                        "service": {
                                "srvce": "_http",
                                "proto": "_tcp",
                                "port": 80
                        },
                        "ttl": 60
                },
                "ttl": 30
        },
        "zookeeper": {
                "servers": [],
                "timeout": 1000
        }
}
HERE

    for ip in $zk_ips
    do
        cat $REGISTRAR_CFG | \
            json -e "zookeeper.servers.push({ host: \\"$ip\\", port: 2181 });" \
            > /tmp/.registrar.json
	mv /tmp/.registrar.json $REGISTRAR_CFG
    done
}


# Mainline

echo "Updating ~/.bashrc"
update_env

echo "Updating /etc/resolv.conf"
update_dns

echo "Updating registrar configuration"
update_registrar

svccfg import /opt/smartdc/registrar/smf/manifests/registrar.xml
svcadm enable registrar

echo "Updating muppet configuration"
update_muppet

svccfg import /opt/local/share/smf/haproxy/manifest.xml
svccfg import /opt/smartdc/muppet/smf/manifests/muppet.xml
svcadm enable haproxy
svcadm enable muppet

exit 0
