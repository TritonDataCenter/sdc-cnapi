#!/bin/bash

set -o xtrace

. /lib/sdc/config.sh

load_sdc_config

PUTOBJECT="/opt/smartdc/cnapi/build/node/bin/node /opt/smartdc/cnapi/node_modules/.bin/putobject"

MORAYIP=$(cat /opt/smartdc/cnapi/config/config.json | json moray.host)

NUM=100

for i in $(seq 0 $NUM); do
    UUID=$(uuid)
    JSON=$(cat <<END
    { "uuid": "$UUID",
      "hostname": "badger-$RANDOM",
      "setup": true,
      "ram": 1024
    }
END
)

    ${PUTOBJECT} -h ${MORAYIP} -d "${JSON}" cnapi_servers ${UUID}
done
