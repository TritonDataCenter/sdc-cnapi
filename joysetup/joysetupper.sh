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

CONFIGS=/opt/smartdc/cnapi/node.config
JOYSETUP=/opt/smartdc/cnapi/joysetup/joysetup.sh
AGENTSETUP=/opt/smartdc/cnapi/joysetup/agentsetup.sh

JOYDIR=$(dirname $INSTALLER_OUTPUT_PATH)
FILENAME=$(basename $INSTALLER_OUTPUT_PATH)

TEMP_CONFIGS=$JOYDIR/node.config
REMOTE_TMP=/var/tmp/joysetup

if [[ ! -d $CONFIGS ]]; then
  fatal "configs directory doesn't exist"
  exit 1
fi

if [[ ! -f $JOYSETUP ]]; then
  fatal "joysetup.sh doesn't exist"
  exit 1
fi

mkdir -p $JOYDIR

cp -R $CONFIGS $JOYDIR
cp $AGENTSETUP $JOYDIR

cd $JOYDIR

# Run the script from $REMOTE_TMP in case we need to write to some log later
(cat <<__EOF__
#!/bin/bash
mkdir -p $REMOTE_TMP
cd $REMOTE_TMP
__EOF__
)> $FILENAME

(/opt/local/bin/shar -n "Joyent" ./* \
    | grep -v '^exit 0')>> $FILENAME

(cat $JOYSETUP)>> $FILENAME

#rm -rf $JOYDIR

echo "Done."
