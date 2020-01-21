#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2019 Joyent, Inc.
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

NAME = cnapi

#
# Tools
#
NODEUNIT	:= ./node_modules/nodeunit/bin/nodeunit

#
# Files
#
REPO_ROOT	= $(shell pwd)
JS_FILES	:= $(shell ls *.js 2>/dev/null) $(shell find bin lib test tools -name '*.js' 2>/dev/null)
JSL_CONF_NODE	= $(REPO_ROOT)/tools/jsl.node.conf
JSL_FILES_NODE	= $(JS_FILES)
JSSTYLE_FILES	= $(JS_FILES)
JSSTYLE_FLAGS	= -o indent=4,doxygen,unparenthesized-return=0
SMF_MANIFESTS_IN = smf/manifests/cnapi.xml.in

NODE_PREBUILT_VERSION=v6.17.0
NODE_PREBUILT_TAG=zone64
ifeq ($(shell uname -s),SunOS)
	# minimal-64-lts@18.4.0
	NODE_PREBUILT_IMAGE=c2c31b00-1d60-11e9-9a77-ff9f06554b0f
endif

COAL ?= root@10.99.99.7

#
# Included definitions
#
ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
else
	NPM=npm
	NODE=node
	NPM_EXEC=$(shell which npm)
	NODE_EXEC=$(shell which node)
endif
include ./deps/eng/tools/mk/Makefile.smf.defs

ROOT            := $(shell pwd)
RELEASE_TARBALL := $(NAME)-pkg-$(STAMP).tar.gz
RELSTAGEDIR          := /tmp/$(NAME)-$(STAMP)

# our base image is triton-origin-x86_64-18.4.0
BASE_IMAGE_UUID = a9368831-958e-432d-a031-f8ce6768d190
BUILDIMAGE_NAME = $(NAME)
BUILDIMAGE_DESC	= SDC CNAPI
AGENTS		= amon config registrar

#
# Repo-specific targets
#
.PHONY: all
all: | $(NPM_EXEC) sdc-scripts
	$(NPM) install

.PHONY: test
test: $(NODEUNIT)
	cd $(REPO_ROOT) && PATH=$(REPO_ROOT)/build/node/bin node ./node_modules/.bin/nodeunit test

.PHONY: test-coal
test-coal:
	ssh $(COAL) 'zlogin $$(/opt/smartdc/bin/sdc-vmname cnapi) "cd /opt/smartdc/cnapi && ./test/runtests -r verbose $(TEST_ARGS)"'

.PHONY: test-coal-quick
test-coal-quick:
	ssh $(COAL) 'zlogin $$(/opt/smartdc/bin/sdc-vmname cnapi) "cd /opt/smartdc/cnapi && /opt/smartdc/cnapi/build/node/bin/node /opt/smartdc/cnapi/node_modules/.bin/nodeunit --reporter verbose test/api $(shell ls test/*.js | grep -v zfs) test/model"'

.PHONY: test-coal-task
test-coal-task:
	ssh $(COAL) 'zlogin $$(/opt/smartdc/bin/sdc-vmname cnapi) "cd /opt/smartdc/cnapi && /opt/smartdc/cnapi/build/node/bin/node /opt/smartdc/cnapi/node_modules/.bin/nodeunit --reporter verbose $(shell ls test/api/*.js | grep task)"'

.PHONY: test-coal-model
test-coal-model:
	ssh $(COAL) 'zlogin $$(/opt/smartdc/bin/sdc-vmname cnapi) "cd /opt/smartdc/cnapi && /opt/smartdc/cnapi/build/node/bin/node /opt/smartdc/cnapi/node_modules/.bin/nodeunit --reporter verbose $(shell ls test/model/*.js)"'

.PHONY: release
release: all deps tocs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/cnapi
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	cp -r   $(ROOT)/build \
		$(ROOT)/bin \
		$(ROOT)/config \
		$(ROOT)/lib \
		$(ROOT)/Makefile \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/sapi_manifests \
		$(ROOT)/smf \
		$(ROOT)/test \
		$(ROOT)/tools \
		$(RELSTAGEDIR)/root/opt/smartdc/cnapi/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

./node_modules/.bin/doctoc:
	npm install

# Make a table of contents in Markdown docs that are setup to use it.  This
# changes those files in-place, so one should do this before commit.
.PHONY: tocs
tocs: | ./node_modules/.bin/doctoc
	./node_modules/.bin/doctoc --notitle --maxlevel 2 docs/README.md


.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/cnapi
	cp $(ROOT)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/cnapi/$(RELEASE_TARBALL)


#
# Includes
#
include ./deps/eng/tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
    include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
endif
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
