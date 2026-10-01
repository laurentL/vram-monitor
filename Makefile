# SPDX-License-Identifier: GPL-2.0-or-later

UUID := vram-monitor@laurentl.github.io
SCHEMA := schemas/org.gnome.shell.extensions.vram-monitor.gschema.xml
POT := po/vram-monitor.pot
PO_FILES := $(wildcard po/*.po)
JS_FILES := extension.js prefs.js gpu.js
ZIP := dist/$(UUID).shell-extension.zip

# Nested sessions moved from --nested to --devkit in GNOME 49.
SHELL_MAJOR := $(shell gnome-shell --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/')
NESTED_FLAG := $(shell [ "$(SHELL_MAJOR)" -ge 49 ] 2>/dev/null && echo --devkit || echo --nested)

.PHONY: all pack install uninstall schemas lint pot update-po nested clean

all: pack

$(ZIP): $(JS_FILES) metadata.json stylesheet.css $(SCHEMA) $(PO_FILES)
	@mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=gpu.js \
		--podir=po \
		.

pack: $(ZIP)

install: $(ZIP)
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

# Only needed when running the extension from a symlinked source tree.
schemas:
	glib-compile-schemas schemas/

lint:
	npx eslint .

pot:
	xgettext --from-code=UTF-8 --add-comments=Translators \
		--package-name=$(UUID) --msgid-bugs-address=https://github.com/laurentL/vram-monitor/issues \
		--keyword=_ --keyword=ngettext:1,2 \
		--output=$(POT) $(JS_FILES) $(SCHEMA)

update-po: pot
	for po in $(PO_FILES); do msgmerge --quiet --update --backup=none $$po $(POT); done

# Shares your real settings (dconf): enabling the extension in the nested
# session also enables it in your own session.
nested:
	env MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x1000 \
		dbus-run-session -- gnome-shell $(NESTED_FLAG) --wayland

clean:
	rm -rf dist schemas/gschemas.compiled
