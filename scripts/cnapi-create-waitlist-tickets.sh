set -o xtrace
expiry_far=$(/usr/node/bin/node -e 'console.log(new Date((new Date().valueOf()) + 10*1000).toISOString())')
obj="{ \"scope\": \"foo\", \"id\": \"bar\", \"expires_at\": \"$expiry_far\" }"
NUM=$1

for i in $(seq 1 $NUM); do
    sdc-cnapi /servers/$(sysinfo |json UUID)/tickets -X POST -d "$obj" &
done
