#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#set -o xtrace

ZONENAME=$(zonename)
#echo $1

if [[ -z "$1" ]]; then
    TARGET="test/*.js"
else
    TARGET="$1"
fi

RSYNC_CMD="rsync --recursive --partial -l ./{config,bin,lib,test} /zones/`sdc-login cnapi zonename`/root/opt/smartdc/cnapi"
RUNTEST_CMD="cd /opt/smartdc/cnapi && ./test/runtests -r default"
RUNTEST_CMD_ZONE="sdc-login cnapi '$RUNTEST_CMD'"

if [[ "$ZONENAME" == "global" ]]; then
    echo "Running from global zone"

    eval "$RSYNC_CMD"
    eval "$RUNTEST_CMD_ZONE"
else
    eval "$RUNTEST_CMD"
fi

