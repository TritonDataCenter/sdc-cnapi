#!/bin/bash

set -o xtrace

MUSKIE_CFG=/opt/smartdc/muskie/etc/config.json
PATH=/opt/smartdc/muskie/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH
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


function setup_muskie {
    local indexers
    local stor_name

    indexers=$(mdata-get moray_indexer_names)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve domain name"
    stor_name=$(mdata-get moray_storage_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve moray storage name"

    echo "Generating muskie.cfg"
    cat > $MUSKIE_CFG <<HERE
{
        "port": 80,
        "index": {
                "connectTimeout": 500,
                "maxClients": 100,
                "replicas": 100,
                "urls": [],
                "retry": {
                        "retries": 2
                }
        },
        "marlin": {
                "connectTimeout": 500,
                "url": "http://$stor_name"
        },
        "storage": {
                "url": "http://$stor_name"
        },
        "sharkConfig": {
                "connectTimeout": 250,
                "maxIdleTime": 1000,
                "maxClients": 50,
                "retry": {
                        "retries": 2
                }
        }
}
HERE

    for shard in $indexers
    do
        cat $MUSKIE_CFG | \
            json -e "index.urls.push( \\"http://$shard\\");" \
            > /tmp/.muskie.json
	mv /tmp/.muskie.json $MUSKIE_CFG
    done

    svccfg import /opt/smartdc/muskie/smf/manifests/muskie.xml
    svcadm enable muskie
}


# Mainline

echo "Updating ~/.bashrc"
update_env

echo "Updating /etc/resolv.conf"
update_dns

echo "Updating registrar configuration"
setup_registrar

echo "Updating muskie configuration"
setup_muskie

exit 0
