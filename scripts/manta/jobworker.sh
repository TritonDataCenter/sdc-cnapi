#!/bin/bash

set -o xtrace

MARLIN_CFG=/opt/smartdc/marlin/etc/config.json
PATH=/opt/smartdc/marlin/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH
REGISTRAR_CFG=/opt/smartdc/registrar/etc/config.json

function fatal
{
    echo "$(basename $0): fatal error: $*"
    exit 1
}

function update_dns {
    local domain_name
    local nameservers
    domain_name=$(mdata-get domain_name)
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


function setup_registrar {
    local my_ip
    local svc_name
    local zk_ips

    my_ip=$(mdata-get sdc:nics.0.ip)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve our own IP address"
    svc_name=$(mdata-get domain_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve domain name"
    zk_ips=$(mdata-get nameservers)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve nameservers from metadata"

    echo "Generating registrar.cfg"
    cat > $REGISTRAR_CFG <<HERE
{
        "registration": {
                "domain": "$svc_name",
                "type": "host",
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

    svccfg import /opt/smartdc/registrar/smf/manifests/registrar.xml
    svcadm enable registrar
}


function setup_marlin {
    local uuid
    local indexers
    local stor_name

    uuid=$(mdata-get sdc:zonename)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve zonename"
    indexers=$(mdata-get moray_indexer_names)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve moray indexer names"
    stor_name=$(mdata-get moray_storage_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve moray storage name"

    echo "Generating $MARLIN_CFG"
    cat > $MARLIN_CFG <<HERE
{
        "instanceUuid": "$uuid",
        "port": 80,
        "moray": {
                "indexing": {
                        "urls": [],
                        "replicas": 100
                },
                "storage": {
                        "url": "http://$stor_name"
                }
        },

        "jobsBucket": "marlinJobs",
        "taskGroupsBucket": "marlinTaskGroups",

        "jobAbandonTime": 30000,
        "findInterval": 1000,
        "taskGroupInterval": 1000,
        "saveInterval": 10000,
        "tickInterval": 1000,
        "taskGroupIdleTime": 40000

}
HERE

    for shard in $indexers
    do
        cat $MARLIN_CFG | \
            json -e "moray.indexing.urls.push( \\"http://$shard\\");" \
            > /tmp/.marlin.json
        mv /tmp/.marlin.json $MARLIN_CFG
    done

    svccfg import /opt/smartdc/marlin/smf/manifests/marlin-worker.xml
    svcadm enable marlin
}


# Mainline

echo "Updating ~/.bashrc"
update_env

echo "Updating /etc/resolv.conf"
update_dns

echo "Updating registrar configuration"
setup_registrar

echo "Updating marlin configuration"
setup_marlin

exit 0
