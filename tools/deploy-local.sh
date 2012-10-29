set -o xtrace
DIRNAME=$(cd `dirname $0`/.. && pwd)
cd $DIRNAME

rsync --recursive --partial -l ./{Makefile,deps,config,bin,lib,test,package.json} /zones/`sdc-login cnapi zonename`/root/opt/smartdc/cnapi

if [[ -z "$NO_RESTART" ]]; then
    sdc-login cnapi 'svcadm enable cnapi; svcadm restart cnapi; svcadm clear cnapi; tail -n 50 `svcs -L cnapi`; svcs cnapi'
fi
