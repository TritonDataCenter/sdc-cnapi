set -o xtrace
DIRNAME=$(cd `dirname $0`/.. && pwd)
cd $DIRNAME

rsync --recursive --partial -l ./{config,bin,lib,test} /zones/`sdc-login cnapi zonename`/root/opt/smartdc/cnapi

if [[ -z "$NO_RESTART" ]]; then
    sdc-login cnapi 'svcadm restart cnapi; svcadm clear cnapi; sleep 5; tail -n 50 `svcs -L cnapi`; svcs cnapi'
fi
