#!/bin/bash

set -x xtrace

. /lib/sdc/config.sh
load_sdc_config

sdc-login cnapi svcadm disable cnapi
sdc-login cnapi /opt/smartdc/cnapi/{build/node/bin/node,node_modules/.bin/delbucket} -h $CONFIG_moray_admin_ips cnapi_servers
sdc-login cnapi svcadm enable cnapi
