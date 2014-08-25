#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

set -o xtrace
DIRNAME=$(cd `dirname $0`/.. && pwd)
cd $DIRNAME

if [[ -n "$CLEAR" ]]; then
    $DIRNAME/scripts/cnapi-delete-all-servers.sh
fi

rsync --recursive --partial -l ./{share,package.json,scripts,deps,config,bin,lib,test} /zones/$(sdc-vmname cnapi)/root/opt/smartdc/cnapi

if [[ -z "$NO_RESTART" ]]; then
    sdc-login cnapi 'svcadm restart cnapi; svcadm clear cnapi; tail -n 50 `svcs -L cnapi`; svcs cnapi'
fi

if [[ -n "$TEST" ]]; then
    sdc-login cnapi "cd /opt/smartdc/cnapi && ./build/node/bin/node ./node_modules/nodeunit/bin/nodeunit $*"
fi
