#!/bin/bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Copyright (c) 2017, Joyent, Inc.
#
# This command shows the reasoning that dapi (embedded within cnapi)
# used when deciding where the most recent allocation should go. When
# dapi makes an allocation, it dumps a gzipped & base64-encoded JSON
# blob into cnapi's logs which includes a great deal of information about
# the allocation, including the 'steps' attribute; that attribute is what
# we seek to extract here.
#
# If this command receives an argument, it is assumed to be a VM UUID
# (which the command converts to a request_id), or a request_id. The request_id
# is used to search through cnapi's logs.
#
# If the VM UUID isn't provided, the command will only display the most
# recent dapi dump -- this may omit details if an allocation took several
# trips through dapi to complete.

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


if [[ $# -ne 1 ]]; then
    echo "Usage: alloc-reasons.sh [-l] [UUID]" 1>&2
    echo "  UUID must be a VM or request UUID. It can be omitted if -l is provided instead." 1>&2
    echo "  -l shows the latest allocation snapshot, but may miss some allocation steps." 1>&2
    exit 1
fi

if [[ "$1" == "-l" ]]; then
    MAX_RESULTS=1
    ID=snapshot

    echo "Some allocation details may be missed without a VM or request UUID" 1>&2
else
    MAX_RESULTS=9999

    UUID=$1
    WFAPI_URL=$(json wfapi.url < /opt/smartdc/cnapi/config/config.json)
    ID=$(curl -s $WFAPI_URL/jobs?vm_uuid=$UUID | json -Ha params.x-request-id | tail -1)

    if [[ -z "$ID" ]]; then
        ID=$UUID
    fi
fi

grep -h $ID $(ls /var/log/sdc/upload/cnapi_* 2> /dev/null | sort) $(svcs -L cnapi) \
    | bunyan -c this.snapshot -o bunyan --strict \
    | tail -$MAX_RESULTS \
    | json -ga snapshot \
| while read snap; do
    echo "$snap" | /opt/local/bin/base64 -d | gunzip - | json steps
done
