// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 laurentL

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Gpu from './gpu.js';

const GIB = 1024 ** 3;

/**
 * Binds an Adw.ComboRow to a string setting, `values[i]` being the setting
 * value of the i-th item.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {Adw.ComboRow} row
 * @param {string[]} values
 */
function bindComboRow(settings, key, row, values) {
    // An unknown value (e.g. a GPU that is no longer present) is shown as
    // the first item but left untouched until the user picks something.
    let syncing = false;
    const sync = () => {
        syncing = true;
        row.selected = Math.max(values.indexOf(settings.get_string(key)), 0);
        syncing = false;
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        if (!syncing)
            settings.set_string(key, values[row.selected]);
    });
}

function createSpinRow(settings, key, title, subtitle, lower, upper) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class VramMonitorPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const cards = await Gpu.readCards();

        window.set_default_size(720, 620);
        const page = new Adw.PreferencesPage({icon_name: 'utilities-system-monitor-symbolic'});
        window.add(page);

        const display = new Adw.PreferencesGroup({title: _('Display')});
        page.add(display);

        const formatRow = new Adw.ComboRow({
            title: _('Label format'),
            use_subtitle: true,
            model: Gtk.StringList.new([
                _('Full — VRAM 21.1/24.0 GB · 2.9 free'),
                _('Compact — VRAM 21.1/24.0 GB'),
                _('Percentage — VRAM 88%'),
            ]),
        });
        bindComboRow(settings, 'label-format', formatRow, ['full', 'compact', 'percent']);
        display.add(formatRow);

        display.add(createSpinRow(settings, 'alert-threshold', _('Alert threshold'),
            _('Highlight the label above this VRAM usage (%)'), 50, 100));

        const monitoring = new Adw.PreferencesGroup({title: _('Monitoring')});
        page.add(monitoring);

        const gpuRow = new Adw.ComboRow({
            title: _('GPU'),
            subtitle: cards.length === 0 ? _('No supported GPU detected') : '',
            model: Gtk.StringList.new([
                _('Automatic (most VRAM)'),
                ...cards.map(card => `${card.name} — ${card.pdev} — ${
                    _('%s GB').replace('%s', (card.vramTotal / GIB).toFixed(1))}`),
            ]),
        });
        bindComboRow(settings, 'gpu', gpuRow, ['', ...cards.map(card => card.pdev)]);
        monitoring.add(gpuRow);

        monitoring.add(createSpinRow(settings, 'refresh-interval', _('Refresh interval'),
            _('Seconds between updates'), 1, 60));
        monitoring.add(createSpinRow(settings, 'max-processes', _('Maximum processes'),
            _('Number of processes listed in the menu'), 1, 50));
    }
}
