set -o xtrace
DIRNAME=$(cd `dirname $0`/.. && pwd)
cd $DIRNAME

rsync --recursive --partial -l ./{deps,config,bin,lib,test} /zones/$(sdc-vmname cnapi)/root/opt/smartdc/cnapi

if [[ -z "$NO_RESTART" ]]; then
    sdc-login cnapi 'svcadm restart cnapi; svcadm clear cnapi; tail -n 50 `svcs -L cnapi`; svcs cnapi'
fi

if [[ -n "$TEST" ]]; then
    sdc-login cnapi "cd /opt/smartdc/cnapi && ./build/node/bin/node ./node_modules/nodeunit/bin/nodeunit $*"
fi
