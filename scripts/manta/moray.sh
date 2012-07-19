#!/bin/bash

set -o xtrace

MORAY_CFG=/opt/smartdc/moray/etc/config.json
PATH=/opt/smartdc/moray/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH
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


function create_pg {
    local svc_name
    svc_name=$(mdata-get service_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve service name"

    # Postgres sucks at return codes, so we basically have no choice but to
    # ignore the error code here (i.e., no matter what it's always 0 or 1).
    createdb -h pg.$svc_name -p 5432 -U postgres moray
}


function update_moray {
    local svc_name
    svc_name=$(mdata-get service_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve service name"

    echo "Generating moray.cfg"
    cat > $MORAY_CFG <<HERE
{
        "port": 80,
        "postgres": {
                "url": "pg://postgres@pg.$svc_name/moray",
                "maxConns": 10,
                "idleTimeout": 60000
        },
        "marker": {
                "key": "13F435C10F0EC0C403E7AACB61429713",
                "iv": "FF5442563050A98984F7DC703185B965"
        }
}
HERE
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
}


# Mainline

echo "Updating ~/.bashrc"
update_env

echo "Updating /etc/resolv.conf"
update_dns

echo "Creating Postgres database"
create_pg

echo "Updating registrar configuration"
update_registrar

svccfg import /opt/smartdc/registrar/smf/manifests/registrar.xml
svcadm enable registrar

echo "Updating moray configuration"
update_moray

svccfg import /opt/smartdc/moray/smf/manifests/moray.xml
svcadm enable moray


exit 0
