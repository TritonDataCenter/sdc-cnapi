#!/usr/bin/bash

set -o xtrace
set -o errexit

ZONE_UUID=$(zonename)

MANTA_ROOT=/manta
NGINX_TEMP=${MANTA_ROOT}/nginx_temp
ZONE_DATASET=zones/$ZONE_UUID/data

MINNOW_CFG=/opt/smartdc/minnow/etc/config.json
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
    echo "alias ls='/usr/bin/ls -U1'" >>/root/.bashrc
}


function setup_registrar {
    local my_ip
    local svc_name
    local zk_ips

    my_ip=$(mdata-get sdc:nics.0.ip)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve our own IP address"
    svc_name=$(mdata-get domain_name)
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

    svccfg import /opt/smartdc/registrar/smf/manifests/registrar.xml
    svcadm enable registrar
}


function setup_minnow {
    local dc_name
    local my_ip
    local server_uuid
    local svc_name
    local zk_ips
    local zone_uuid

    my_ip=$(mdata-get sdc:nics.0.ip)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve our own IP address"
    dc_name=$(mdata-get sdc:datacenter_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve datacenter name"
    domain_name=$(mdata-get domain_name)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve service name"
    moray_url=$(mdata-get moray_url)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve moray_url"
    server_uuid=$(mdata-get sdc:server_uuid)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve server uuid"
    zone_uuid=$(mdata-get sdc:zonename)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve zone uuid"

    echo "Generating minnow.cfg"
    cat > $MINNOW_CFG <<HERE
{
        "moray": {
                "bucket": {
                        "name": "manta_storage",
                        "schema": {
                                "hostname": { "type": "string" },
                                "availableMB": { "type": "number" },
                                "percentUsed": { "type": "number" },
                                "server_uuid": { "type": "string" },
                                "timestamp": { "type": "number" },
                                "zone_uuid": { "type": "string" }
                        }
                },
                "connectTimeout": 200,
                "retry": {
                        "retries": 2,
                        "minTimeout": 500
                },
                "url": "http://${moray_url}"
        },
        "datacenter": "${dc_name}",
        "domain": "${domain_name}",
        "objectRoot": "${MANTA_ROOT}",
        "server_uuid": "${server_uuid}",
        "zone_uuid": "${zone_uuid}",
        "interval": 5000
}
HERE

    svccfg import /opt/smartdc/minnow/smf/manifests/minnow.xml
    svcadm enable minnow
}


function setup_nginx {
    echo "Updating ZFS configuration"
    zfs set compression=lzjb $ZONE_DATASET

    mkdir -p $MANTA_ROOT

    zfs set mountpoint=$MANTA_ROOT $ZONE_DATASET

    chmod 777 $MANTA_ROOT
    chown nobody:nobody $MANTA_ROOT
    mkdir -p $NGINX_TEMP

    svccfg import /opt/smartdc/mako/smf/manifests/nginx.xml
    svcadm enable -s mako
}


# Mainline

echo "Updating ~/.bashrc"
update_env

echo "Updating /etc/resolv.conf"
update_dns

echo "Updating registrar"
setup_registrar

echo "Updating minnow"
setup_minnow

echo "Updating nginx"
setup_nginx

exit 0
