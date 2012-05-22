DIRNAME=$(cd `dirname $0`/.. && pwd)
cd $DIRNAME
#WHAT=bin,lib,node_modules
rsync --recursive --partial -l ./{node.config,joysetup,bin,lib} /zones/`sdc-login cnapi zonename`/root/opt/smartdc/cnapi
sdc-login cnapi 'svcadm restart cnapi; svcadm clear cnapi; sleep 5; tail -n 50 `svcs -L cnapi`; svcs cnapi'
