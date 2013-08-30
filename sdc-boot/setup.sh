#!/usr/bin/bash
#
# Copyright (c) 2011 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

role=cnapi
app_name=$role

CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/sdc-boot/scripts/util.sh
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/cnapi

# Install CNAPI
mkdir -p /opt/smartdc/cnapi
chown -R nobody:nobody /opt/smartdc/cnapi

# Add node_modules/bin to PATH
echo "" >>/root/.profile
echo "export PATH=\$PATH:/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin" >>/root/.profile

echo "Adding log rotation"
logadm -w cnapi -C 48 -s 100m -p 1h \
    /var/svc/log/smartdc-site-cnapi:default.log

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
