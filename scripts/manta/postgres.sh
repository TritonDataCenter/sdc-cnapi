#!/usr/bin/bash

set -o xtrace

PATH=/opt/smartdc/registrar/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH
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
                "type": "db_host",
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

ZONE_UUID=`zoneadm list -p | cut -d ':' -f2`
DATASET=zones/$ZONE_UUID/data
DATASET_DIR=/zones/$ZONE_UUID/data
PG_DIR=$DATASET_DIR/pg
ZONE_IP=`mdata-get sdc:nics.0.ip`
MANATEE_CFG_FILE=/opt/smartdc/manatee/cfg/manatee.json
SNAPSHOT_CFG_FILE=/opt/smartdc/manatee/cfg/snapshotter.json
BACKUP_CFG_FILE=/opt/smartdc/manatee/cfg/backupserver.json

# create postgres user
echo "creating postgres user"
useradd postgres

# grant postgres user root privileges with pfexec
echo "grant postgres user root privileges"
usermod -P'Primary Administrator' postgres

# give postgres user zfs permmissions.
echo "grant postgres user zfs perms"
zfs allow -ld postgres create,destroy,snapshot,mount,send,receive $DATASET

# change dataset perms such that manatee can access the dataset and mount/unmount
chmod 777 -R /zones/$ZONE_UUID/

# make the pg data dir
echo "creating $PG_DIR"
mkdir -p $PG_DIR
chown postgres $PG_DIR
chmod 700 $PG_DIR

# make .zfs dir visible for snapshots
echo "make snapshot dir visible"
zfs set snapdir=visible $DATASET

# mdata-get all of the metadata and drop it into the various configs
echo "getting configs from data-get"
REGISTRAR_PATH=`mdata-get MANATEE_REGISTRAR_PATH`
[[ $? -eq 0 ]] || fatal "Unable to retrieve MANATEE_REGISTRAR_PATH from metadata"
REGISTRAR_PATH_PREFIX=`mdata-get MANATEE_REGISTRAR_PATH_PREFIX`
[[ $? -eq 0 ]] || fatal "Unable to retrieve MANATEE_REGISTRAR_PATH_PREFIX from metadata"
SHARD_PATH=`mdata-get MANATEE_SHARD_PATH`
[[ $? -eq 0 ]] || fatal "Unable to retrieve MANATEE_SHARD_PATH from metadata"
SHARD_ID=`mdata-get MANATEE_SHARD_ID`
[[ $? -eq 0 ]] || fatal "Unable to retrieve MANATEE_SHARD_ID from metadata"

# additional configs
BACKUP_SERVER_PORT=12345
BACKUP_URL=http://$ZONE_IP:$BACKUP_SERVER_PORT
SNAPSHOT_INTERVAL=3600000
SNAPSHOT_NUMBER=5
TTL=10
ZK_URL=`mdata-get MANATEE_ZK_URL`
ZK_TIMEOUT=200
ZFS_RECV_PATH=/opt/smartdc/manatee/bin/zfs_recv
ZFS_RECV_PORT=1234
ZFS_SEND_PATH=/opt/smartdc/manatee/bin/zfs_send
PG_URL=tcp://postgres@$ZONE_IP:5432/postgres
SNAPSHOT_DIR=$DATASET_DIR/.zfs/snapshot/

# update manatee cfg file
echo "Updating /opt/smartdc/manatee/cfg/manatee.json"
cp /opt/smartdc/manatee/cfg/manatee.json.in $MANATEE_CFG_FILE
gsed -i -e "s|SHARD_PATH|$SHARD_PATH|g" $MANATEE_CFG_FILE
gsed -i -e "s|BACKUP_URL|$BACKUP_URL|g" $MANATEE_CFG_FILE
gsed -i -e "s|SHARD_ID|$SHARD_ID|g" $MANATEE_CFG_FILE
gsed -i -e "s|TTL|$TTL|g" $MANATEE_CFG_FILE
gsed -i -e "s|REGISTRAR_PATH|$REGISTRAR_PATH|g" $MANATEE_CFG_FILE
gsed -i -e "s|REGISTRAR_PREFIX_PATH|$REGISTRAR_PATH_PREFIX|g" $MANATEE_CFG_FILE
gsed -i -e "s|PG_URL|$PG_URL|g" $MANATEE_CFG_FILE
gsed -i -e "s|PG_DIR|$PG_DIR|g" $MANATEE_CFG_FILE
gsed -i -e "s|ZK_URL|$ZK_URL|g" $MANATEE_CFG_FILE
gsed -i -e "s|DATASET|$DATASET|g" $MANATEE_CFG_FILE
gsed -i -e "s|SNAPSHOT_DIR|$SNAPSHOT_DIR|g" $MANATEE_CFG_FILE
gsed -i -e "s|ZK_TIMEOUT|$ZK_TIMEOUT|g" $MANATEE_CFG_FILE
gsed -i -e "s|ZFS_RECV_IP|$ZONE_IP|g" $MANATEE_CFG_FILE
gsed -i -e "s|ZFS_RECV_PATH|$ZFS_RECV_PATH|g" $MANATEE_CFG_FILE
gsed -i -e "s|ZFS_RECV_PORT|$ZFS_RECV_PORT|g" $MANATEE_CFG_FILE

# update snapshot cfg file
echo "Updating /opt/smartdc/manatee/cfg/snapshotter.json"
cp /opt/smartdc/manatee/cfg/snapshotter.json.in $SNAPSHOT_CFG_FILE
gsed -i -e "s|DATASET|$DATASET|g" $SNAPSHOT_CFG_FILE
gsed -i -e "s|SNAPSHOT_DIR|$SNAPSHOT_DIR|g" $SNAPSHOT_CFG_FILE
gsed -i -e "s|SNAPSHOT_INTERVAL|$SNAPSHOT_INTERVAL|g" $SNAPSHOT_CFG_FILE
gsed -i -e "s|SNAPSHOT_NUMBER|$SNAPSHOT_NUMBER|g" $SNAPSHOT_CFG_FILE
gsed -i -e "s|PG_URL|$PG_URL|g" $SNAPSHOT_CFG_FILE

# update backupServer cfg file
echo "Updating /opt/smartdc/manatee/cfg/backupserver.json"
cp /opt/smartdc/manatee/cfg/backupserver.json.in $BACKUP_CFG_FILE
gsed -i -e "s|DATASET|$DATASET|g" $BACKUP_CFG_FILE
gsed -i -e "s|SNAPSHOT_DIR|$SNAPSHOT_DIR|g" $BACKUP_CFG_FILE
gsed -i -e "s|BACKUP_SERVER_PORT|$BACKUP_SERVER_PORT|g" $BACKUP_CFG_FILE
gsed -i -e "s|ZFS_SEND_PATH|$ZFS_SEND_PATH|g" $BACKUP_CFG_FILE

echo "Updating ~/.bashrc"
update_env

# Add Log rotation
logadm -w manatee -C 48 -c -p 1h /var/svc/log/sds-application-manatee:default.log
logadm -w manatee-snapshotter -C 48 -c -p 1h /var/svc/log/sds-application-manatee-snapshotter:default.log
logadm -w manatee-backupserver -C 48 -c -p 1h /var/svc/log/sds-application-manatee-backupserver:default.log

# update dns
echo "Updating /etc/resolv.conf"
update_dns

# update registrar
echo "Updating registrar configuration"
update_registrar
svccfg import /opt/smartdc/registrar/smf/manifests/registrar.xml
svcadm enable registrar

# import services
echo "Starting snapshotter"
svccfg import /opt/smartdc/manatee/smf/manifests/snapshotter.xml
svcadm enable manatee-snapshotter

echo "Starting backupserver"
svccfg import /opt/smartdc/manatee/smf/manifests/backupserver.xml
svcadm enable manatee-backupserver

echo "Starting manatee"
svccfg import /opt/smartdc/manatee/smf/manifests/manatee.xml
svcadm enable manatee

