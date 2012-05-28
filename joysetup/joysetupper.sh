#!/usr/bin/bash

set -o errexit
set -o pipefail
set -o xtrace

fatal() {
    echo $* >&2
}

INSTALLER_OUTPUT_PATH=$1

if [[ -z $1 ]]; then
  fatal "cannot create joysetupper script without an output filename"
  exit 1
fi

AGENTSETUP=/opt/smartdc/cnapi/joysetup/agentsetup.sh

JOYDIR=$(dirname $INSTALLER_OUTPUT_PATH)
FILENAME=$(basename $INSTALLER_OUTPUT_PATH)
REMOTE_TMP=/var/tmp
ASSETS_IP=$(mdata-get assets-ip)
JOYSETUP=$JOYDIR/joysetup.sh

mkdir -p $JOYDIR
mkdir -p $JOYDIR/node.config

cp $AGENTSETUP $JOYDIR

cd $JOYDIR
curl -o node.config/node.config http://${ASSETS_IP}/extra/joysetup/node.config
curl -O http://${ASSETS_IP}/extra/joysetup/joysetup.sh

# Run the script from $REMOTE_TMP in case we need to write to some log later
(cat <<__EOF__
#!/bin/bash
cd $REMOTE_TMP
ASSETS_IP=$ASSETS_IP
__EOF__
)> $FILENAME

(/opt/local/bin/shar -n "Joyent" node.config/node.config agentsetup.sh \
    | grep -v '^exit 0')>> $FILENAME

(cat $JOYSETUP)>> $FILENAME

echo "Done."
