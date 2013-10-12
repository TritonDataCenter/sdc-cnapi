#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

echo "Updating SMF manifest"
$(/opt/local/bin/gsed -i"" -e "s/@@PREFIX@@/\/opt\/smartdc\/cnapi/g" /opt/smartdc/cnapi/smf/manifests/cnapi.xml)

echo "Importing cnapi.xml"
/usr/sbin/svccfg import /opt/smartdc/cnapi/smf/manifests/cnapi.xml

exit 0
