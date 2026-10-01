// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 laurentL

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Gpu from './gpu.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const ALERT_STYLE = 'vram-monitor-alert';

function gib(bytes) {
    return (bytes / GIB).toFixed(1);
}

function mib(bytes) {
    return Math.round(bytes / MIB).toString();
}

function formatSize(bytes) {
    return _('%s GB').format(gib(bytes));
}

function formatPercent(ratio) {
    return _('%d%%').format(Math.round(ratio * 100));
}

class InfoRow extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(title) {
        super({activate: false, hover: false, can_focus: false});
        this.add_child(new St.Label({text: title, x_expand: true}));
        this._value = new St.Label({style_class: 'vram-monitor-value'});
        this.add_child(this._value);
    }

    setValue(text) {
        this._value.text = text;
    }
}

// The Shell has no tooltip widget for menus: a single label, styled like the
// dash labels, is shown under the hovered cell.
class Tooltip {
    constructor() {
        this._label = new St.Label({style_class: 'dash-label vram-monitor-tooltip', visible: false});
        this._label.clutter_text.line_wrap = true;
        Main.uiGroup.add_child(this._label);
    }

    show(actor, text) {
        this._label.text = text;
        Main.uiGroup.set_child_above_sibling(this._label, null);

        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        const [, labelWidth] = this._label.get_preferred_width(-1);
        const monitor = Main.layoutManager.findMonitorForActor(actor);
        const labelX = Math.max(monitor.x, Math.min(x + width - labelWidth,
            monitor.x + monitor.width - labelWidth));
        this._label.set_position(Math.floor(labelX), Math.floor(y + height));
        this._label.show();
    }

    hide() {
        this._label.hide();
    }

    destroy() {
        this._label.destroy();
    }
}

class ProcessRow extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    /**
     * @param {Tooltip} [tooltip] - shown over the VRAM cell when it has a
     *   tooltip text
     * @param {string} [styleClass]
     */
    constructor(tooltip = null, styleClass = '') {
        super({activate: false, hover: false, can_focus: false, style_class: styleClass});
        this._tooltip = tooltip;
        this._vramTooltip = null;

        this._name = new St.Label({x_expand: true, style_class: 'vram-monitor-name'});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._pid = new St.Label({style_class: 'vram-monitor-number'});
        this._vram = new St.Label({
            style_class: 'vram-monitor-number',
            reactive: tooltip !== null,
            track_hover: tooltip !== null,
        });
        this._gtt = new St.Label({style_class: 'vram-monitor-number'});
        for (const label of [this._name, this._pid, this._vram, this._gtt])
            this.add_child(label);

        this._vram.connect('notify::hover', () => this._syncTooltip());
        this.connect('destroy', () => {
            if (this._vram.hover)
                this._tooltip.hide();
        });
    }

    update({name, pid, vram, gtt, vramTooltip = null}) {
        this._name.text = name;
        this._pid.text = pid;
        this._vram.text = vram;
        this._gtt.text = gtt;
        this._vramTooltip = vramTooltip;
        if (vramTooltip)
            this._vram.add_style_class_name('vram-monitor-capped');
        else
            this._vram.remove_style_class_name('vram-monitor-capped');
        if (this._vram.hover)
            this._syncTooltip();
    }

    _syncTooltip() {
        if (this._vram.hover && this._vramTooltip)
            this._tooltip.show(this._vram, this._vramTooltip);
        else
            this._tooltip.hide();
    }
}

class AboutDialog extends ModalDialog.ModalDialog {
    static {
        GObject.registerClass(this);
    }

    constructor(metadata) {
        super();
        const version = metadata['version-name'] ?? metadata.version;
        this.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: version ? `${metadata.name} ${version}` : metadata.name,
            description: [
                _('Shows GPU video memory (VRAM) usage in the top bar.'),
                _('License: GPL-2.0-or-later'),
                metadata.url,
            ].join('\n\n'),
        }));
        this.addButton({
            label: _('Website'),
            action: () => {
                Gio.AppInfo.launch_default_for_uri(metadata.url,
                    global.create_app_launch_context(0, -1));
                this.close();
            },
        });
        this.addButton({
            label: _('Close'),
            action: () => this.close(),
            default: true,
            key: Clutter.KEY_Escape,
        });
    }
}

class VramIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(extension, settings) {
        super(0.5, _('VRAM Monitor'));

        this._extension = extension;
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._card = null;
        this._processes = null;
        this._timeoutId = 0;
        this._aboutDialog = null;
        this._tooltip = new Tooltip();
        this._readingCards = false;
        this._readingProcesses = false;

        this._label = new St.Label({
            text: _('VRAM'),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'vram-monitor-label',
        });
        this.add_child(this._label);

        this._buildMenu();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
            else
                this._tooltip.hide();
        });
        this._settings.connectObject('changed', (_settings, key) => {
            this._onSettingChanged(key);
        }, this);

        this._startTimer();
        this._refreshCards();
    }

    _buildMenu() {
        this._cardRow = new InfoRow(_('GPU'));
        this._usedRow = new InfoRow(_('VRAM used'));
        this._freeRow = new InfoRow(_('VRAM free'));
        this._totalRow = new InfoRow(_('VRAM total'));
        this._gttRow = new InfoRow(_('GTT used'));
        for (const row of [this._cardRow, this._usedRow, this._freeRow, this._totalRow, this._gttRow])
            this.menu.addMenuItem(row);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Processes')));
        const header = new ProcessRow(null, 'vram-monitor-header');
        header.update({name: _('Name'), pid: _('PID'), vram: _('VRAM (MB)'), gtt: _('GTT (MB)')});
        this.menu.addMenuItem(header);

        // Rows are updated in place so that a hovered cell keeps its tooltip
        // across refreshes; the message item stays last.
        this._processSection = new PopupMenu.PopupMenuSection();
        this._processRows = [];
        this._processMessage = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._processSection.addMenuItem(this._processMessage);
        this.menu.addMenuItem(this._processSection);

        const notice = new PopupMenu.PopupMenuItem(
            _('Only processes of the current user can be inspected.'),
            {reactive: false, style_class: 'vram-monitor-notice'});
        this.menu.addMenuItem(notice);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Preferences'), () => this._extension.openPreferences());
        this.menu.addAction(_('About'), () => this._openAbout());

        this._updateSummary();
        this._renderProcesses();
    }

    _openAbout() {
        if (!this._aboutDialog) {
            this._aboutDialog = new AboutDialog(this._extension.metadata);
            this._aboutDialog.connect('destroy', () => {
                this._aboutDialog = null;
            });
        }
        this._aboutDialog.open();
    }

    _onSettingChanged(key) {
        switch (key) {
        case 'refresh-interval':
            this._startTimer();
            break;
        case 'gpu':
            this._processes = null;
            this._renderProcesses();
            this._refresh();
            break;
        case 'max-processes':
            this._renderProcesses();
            break;
        default:
            this._updateLabel();
        }
    }

    _startTimer() {
        this._stopTimer();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_uint('refresh-interval'), () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopTimer() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    async _refresh() {
        await this._refreshCards();
        // /proc is only scanned while the menu is visible.
        if (this.menu.isOpen)
            await this._refreshProcesses();
    }

    async _refreshCards() {
        if (this._readingCards)
            return;
        this._readingCards = true;
        try {
            const cards = await Gpu.readCards(this._cancellable);
            this._card = Gpu.pickCard(cards, this._settings.get_string('gpu'));
            this._updateLabel();
            this._updateSummary();
        } catch (e) {
            if (!Gpu.isCancelled(e))
                console.error(e);
        } finally {
            this._readingCards = false;
        }
    }

    async _refreshProcesses() {
        if (this._readingProcesses || !this._card)
            return;
        this._readingProcesses = true;
        try {
            this._processes = await Gpu.readProcesses(this._card.pdev, this._cancellable);
            this._renderProcesses();
        } catch (e) {
            if (!Gpu.isCancelled(e))
                console.error(e);
        } finally {
            this._readingProcesses = false;
        }
    }

    _updateLabel() {
        const card = this._card;
        if (!card) {
            this._label.text = _('VRAM n/a');
            this._label.remove_style_class_name(ALERT_STYLE);
            return;
        }

        const ratio = card.vramUsed / card.vramTotal;
        switch (this._settings.get_string('label-format')) {
        case 'compact':
            this._label.text = _('VRAM %s/%s GB').format(
                gib(card.vramUsed), gib(card.vramTotal));
            break;
        case 'percent':
            this._label.text = _('VRAM %s').format(formatPercent(ratio));
            break;
        default:
            this._label.text = _('VRAM %s/%s GB · %s free').format(
                gib(card.vramUsed), gib(card.vramTotal),
                gib(card.vramTotal - card.vramUsed));
        }

        if (ratio * 100 >= this._settings.get_uint('alert-threshold'))
            this._label.add_style_class_name(ALERT_STYLE);
        else
            this._label.remove_style_class_name(ALERT_STYLE);
    }

    _updateSummary() {
        const card = this._card;
        if (!card) {
            this._cardRow.setValue(_('No supported GPU'));
            for (const row of [this._usedRow, this._freeRow, this._totalRow, this._gttRow])
                row.setValue('—');
            return;
        }

        this._cardRow.setValue(`${card.name} (${card.pdev})`);
        this._usedRow.setValue(`${formatSize(card.vramUsed)} · ${
            formatPercent(card.vramUsed / card.vramTotal)}`);
        this._freeRow.setValue(formatSize(card.vramTotal - card.vramUsed));
        this._totalRow.setValue(formatSize(card.vramTotal));
        this._gttRow.setValue(`${formatSize(card.gttUsed)} / ${formatSize(card.gttTotal)}`);
    }

    _vramCell(vram) {
        // drm-total-vram also counts buffers meant for VRAM that are evicted
        // to system memory, so it can exceed the card's VRAM when it is full.
        const cardVram = this._card.vramTotal;
        if (vram <= cardVram)
            return {vram: mib(vram)};
        return {
            vram: `${mib(cardVram)} +${mib(vram - cardVram)}`,
            vramTooltip: _('The kernel reports %s MB for this process, more than the %s MB of the card: this total also counts buffers meant for VRAM that are currently evicted to system memory.')
                .format(mib(vram), mib(cardVram)),
        };
    }

    _processMessageText(shown) {
        if (!this._card)
            return _('Unavailable');
        if (this._processes === null)
            return _('Scanning…');
        if (this._processes.length === 0)
            return _('No process found');
        const hidden = this._processes.length - shown;
        if (hidden > 0)
            return ngettext('%d more process', '%d more processes', hidden).format(hidden);
        return null;
    }

    _renderProcesses() {
        const max = this._settings.get_uint('max-processes');
        const processes = this._card && this._processes ? this._processes.slice(0, max) : [];

        while (this._processRows.length > processes.length)
            this._processRows.pop().destroy();
        processes.forEach((process, i) => {
            let row = this._processRows[i];
            if (!row) {
                row = new ProcessRow(this._tooltip);
                this._processSection.addMenuItem(row, i);
                this._processRows.push(row);
            }
            row.update({
                name: process.name,
                pid: String(process.pid),
                gtt: mib(process.gtt),
                ...this._vramCell(process.vram),
            });
        });

        const message = this._processMessageText(processes.length);
        this._processMessage.label.text = message ?? '';
        this._processMessage.visible = message !== null;
    }

    destroy() {
        this._cancellable.cancel();
        this._stopTimer();
        this._settings.disconnectObject(this);
        this._aboutDialog?.destroy();
        this._tooltip.destroy();
        super.destroy();
    }
}

export default class VramMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new VramIndicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
