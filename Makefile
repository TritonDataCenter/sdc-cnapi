#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
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
DOC_FILES	= index.restdown
JS_FILES	:= $(shell ls *.js 2>/dev/null) $(shell find bin lib test tools -name '*.js' 2>/dev/null)
JSL_CONF_NODE	= $(REPO_ROOT)/tools/jsl.node.conf
JSL_FILES_NODE	= $(JS_FILES)
JSSTYLE_FILES	= $(JS_FILES)
JSSTYLE_FLAGS	= -o indent=4,doxygen,unparenthesized-return=0
SMF_MANIFESTS_IN = smf/manifests/cnapi.xml.in
SMF_DTD		= $(REPO_ROOT)/tools/service_bundle.dtd.1

NODE_PREBUILT_VERSION=v0.8.14
NODE_PREBUILT_TAG=zone

#
# Included definitions
#
include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node_prebuilt.defs
include ./tools/mk/Makefile.smf.defs

ROOT            := $(shell pwd)
RELEASE_TARBALL := cnapi-pkg-$(STAMP).tar.bz2
TMPDIR          := /tmp/$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: | $(NPM_EXEC) sdc-scripts
	$(NPM) rebuild
	cd $(ROOT) && $(NPM) install

.PHONY: test
test: $(NODEUNIT)
	cd $(REPO_ROOT) && PATH=$(REPO_ROOT)/build/node/bin node ./node_modules/.bin/nodeunit test/test-model-server.js
	cd $(REPO_ROOT) && PATH=$(REPO_ROOT)/build/node/bin node ./node_modules/.bin/nodeunit test/test-zfs.js


.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(TMPDIR)/root/opt/smartdc/cnapi
	@mkdir -p $(TMPDIR)/site
	@touch $(TMPDIR)/site/.do-not-delete-me
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
		$(TMPDIR)/root/opt/smartdc/cnapi/
	mkdir -p $(TMPDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/deps/sdc-scripts/* $(TMPDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/boot/* $(TMPDIR)/root/opt/smartdc/boot/
	(cd $(TMPDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(TMPDIR)

regen_docs:
	$(NODE) ./tools/gendocs.js lib/endpoints > docs/index.restdown

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
include ./tools/mk/Makefile.node_prebuilt.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
