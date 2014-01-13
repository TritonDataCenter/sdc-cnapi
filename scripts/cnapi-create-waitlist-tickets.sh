set -o xtrace
expiry_far=$(/usr/node/bin/node -e 'console.log(new Date((new Date().valueOf()) + 10*1000).toISOString())')
obj="{ \"scope\": \"foo\", \"id\": \"bar\", \"expires_at\": \"$expiry_far\" }"
sdc-cnapi /servers/$(sysinfo |json UUID)/waitlist -X POST -d "$obj"
sdc-cnapi /servers/$(sysinfo |json UUID)/waitlist -X POST -d "$obj"
