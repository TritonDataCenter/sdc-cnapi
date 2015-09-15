#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

#
# Tools
#
NODEUNIT	:= ./node_modules/nodeunit/bin/nodeunit

#
# Files
#
REPO_ROOT	= $(shell pwd)
DOC_FILES	= index.md
EXTRA_DOC_DEPS += deps/restdown-brand-remora/.git
RESTDOWN_FLAGS   = --brand-dir=deps/restdown-brand-remora
JS_FILES	:= $(shell ls *.js 2>/dev/null) $(shell find bin lib test tools -name '*.js' 2>/dev/null)
JSL_CONF_NODE	= $(REPO_ROOT)/tools/jsl.node.conf
JSL_FILES_NODE	= $(JS_FILES)
JSSTYLE_FILES	= $(JS_FILES)
JSSTYLE_FLAGS	= -o indent=4,doxygen,unparenthesized-return=0
SMF_MANIFESTS_IN = smf/manifests/cnapi.xml.in
SMF_DTD		= $(REPO_ROOT)/tools/service_bundle.dtd.1

NODE_PREBUILT_VERSION=v0.10.32
NODE_PREBUILT_TAG=zone
ifeq ($(shell uname -s),SunOS)
	# Allow building on a SmartOS image other than sdc-smartos@1.6.3.
	NODE_PREBUILT_IMAGE=fd2cc906-8938-11e3-beab-4359c665ac99
endif


#
# Included definitions
#
include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	NPM=npm
	NODE=node
	NPM_EXEC=$(shell which npm)
	NODE_EXEC=$(shell which node)
endif
include ./tools/mk/Makefile.smf.defs

ROOT            := $(shell pwd)
RELEASE_TARBALL := cnapi-pkg-$(STAMP).tar.bz2
RELSTAGEDIR          := /tmp/$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: | $(NPM_EXEC) sdc-scripts
	$(NPM) install

.PHONY: test
test: $(NODEUNIT)
	cd $(REPO_ROOT) && PATH=$(REPO_ROOT)/build/node/bin node ./node_modules/.bin/nodeunit test/test-model-server.js
	cd $(REPO_ROOT) && PATH=$(REPO_ROOT)/build/node/bin node ./node_modules/.bin/nodeunit test/test-zfs.js
	cd $(REPO_ROOT) && PATH=$(REPO_ROOT)/build/node/bin node ./node_modules/.bin/nodeunit test/test-allocator.js
	cd $(REPO_ROOT) && PATH=$(REPO_ROOT)/build/node/bin node ./node_modules/.bin/nodeunit test/test-servers.js

.PHONY: test-coal
COAL=root@10.99.99.7
test-coal:
	./tools/rsync-to coal
	ssh $(COAL) 'zlogin $$(/opt/smartdc/bin/sdc-vmname cnapi) "cd /opt/smartdc/cnapi && /opt/smartdc/cnapi/build/node/bin/node /opt/smartdc/cnapi/node_modules/.bin/nodeunit --reporter default test/waitlist"'

.PHONY: test-coal-quick
COAL=root@10.99.99.7
test-coal-quick:
	./tools/rsync-to coal
	ssh $(COAL) 'zlogin $$(/opt/smartdc/bin/sdc-vmname cnapi) "cd /opt/smartdc/cnapi && /opt/smartdc/cnapi/build/node/bin/node /opt/smartdc/cnapi/node_modules/.bin/nodeunit --reporter verbose test/api $(shell ls test/*.js | grep -v zfs) test/model"'

.PHONY: test-coal-task
COAL=root@10.99.99.7
test-coal-task:
	#./tools/rsync-to coal
	ssh $(COAL) 'zlogin $$(/opt/smartdc/bin/sdc-vmname cnapi) "cd /opt/smartdc/cnapi && /opt/smartdc/cnapi/build/node/bin/node /opt/smartdc/cnapi/node_modules/.bin/nodeunit --reporter verbose $(shell ls test/api/*.js | grep task)"'

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/cnapi
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	(git symbolic-ref HEAD | awk -F/ '{print $$3}' && git describe) > $(ROOT)/describe
	cp -r   $(ROOT)/build \
		$(ROOT)/bin \
		$(ROOT)/config \
		$(ROOT)/describe \
		$(ROOT)/lib \
		$(ROOT)/Makefile \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/sapi_manifests \
		$(ROOT)/smf \
		$(ROOT)/test \
		$(ROOT)/share \
		$(ROOT)/tools \
		$(RELSTAGEDIR)/root/opt/smartdc/cnapi/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

regen_docs:
	$(NODE) ./tools/gendocs.js lib/endpoints > docs/index.md

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
    echo "error: 'BITS_DIR' must be set for 'publish' target"; \
    exit 1; \
  fi
	mkdir -p $(BITS_DIR)/cnapi
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/cnapi/$(RELEASE_TARBALL)


#
# Includes
#
include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
    include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
