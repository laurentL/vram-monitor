// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 laurentL

// GPU memory readers. Only amdgpu exposes the sysfs files used here; other
// drivers simply yield no card. Everything is asynchronous and cancellable.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const DRM_SYSFS = '/sys/class/drm';
const CARD_RE = /^card(\d+)$/;
const DRI_NODE_RE = /^\/dev\/dri\/(card|renderD)\d+$/;
const PID_RE = /^\d+$/;
const SIZE_RE = /^(\d+)\s*(KiB|MiB|GiB)?$/;
const UNITS = {KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3};
const ENUMERATE_BATCH = 64;

const decoder = new TextDecoder();

/**
 * @typedef {object} GpuCard
 * @property {string} name - DRM card name, e.g. "card0"
 * @property {string} pdev - PCI address, e.g. "0000:03:00.0"
 * @property {number} vramTotal - bytes
 * @property {number} vramUsed - bytes
 * @property {number} gttTotal - bytes
 * @property {number} gttUsed - bytes
 */

/**
 * @typedef {object} GpuProcess
 * @property {number} pid
 * @property {string} name
 * @property {number} vram - bytes
 * @property {number} gtt - bytes
 */

/**
 * @param {Error} error
 * @returns {boolean}
 */
export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Resolves to null instead of rejecting, except on cancellation. Used for
 * files that may legitimately be missing or unreadable (unsupported driver,
 * other users' processes, processes exiting during the scan).
 *
 * @param {Promise} promise
 */
async function orNull(promise) {
    try {
        return await promise;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

async function readText(path, cancellable) {
    const [contents] = await Gio.File.new_for_path(path)
        .load_contents_async(cancellable);
    return decoder.decode(contents);
}

async function readNumber(path, cancellable) {
    const value = Number.parseInt(await readText(path, cancellable), 10);
    if (!Number.isFinite(value))
        throw new Error(`Unexpected content in ${path}`);
    return value;
}

async function listChildren(path, attributes, cancellable) {
    const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
        attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        GLib.PRIORITY_DEFAULT, cancellable);
    const infos = [];
    try {
        for (;;) {
            // An enumerator can only be drained sequentially.
            // eslint-disable-next-line no-await-in-loop
            const batch = await enumerator.next_files_async(ENUMERATE_BATCH,
                GLib.PRIORITY_DEFAULT, cancellable);
            if (batch.length === 0)
                break;
            infos.push(...batch);
        }
    } finally {
        await orNull(enumerator.close_async(GLib.PRIORITY_DEFAULT, null));
    }
    return infos;
}

async function readCard(name, cancellable) {
    const device = `${DRM_SYSFS}/${name}/device`;
    const [vramTotal, vramUsed, gttTotal, gttUsed, link] = await Promise.all([
        readNumber(`${device}/mem_info_vram_total`, cancellable),
        readNumber(`${device}/mem_info_vram_used`, cancellable),
        readNumber(`${device}/mem_info_gtt_total`, cancellable),
        readNumber(`${device}/mem_info_gtt_used`, cancellable),
        Gio.File.new_for_path(device).query_info_async('standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT,
            cancellable),
    ]);
    if (vramTotal === 0)
        return null;
    const pdev = GLib.path_get_basename(link.get_symlink_target());
    return {name, pdev, vramTotal, vramUsed, gttTotal, gttUsed};
}

/**
 * Lists the cards exposing VRAM counters in sysfs.
 *
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<GpuCard[]>}
 */
export async function readCards(cancellable = null) {
    const entries = await orNull(listChildren(DRM_SYSFS, 'standard::name',
        cancellable)) ?? [];
    const names = entries
        .map(info => info.get_name())
        .filter(name => CARD_RE.test(name))
        .sort((a, b) => a.match(CARD_RE)[1] - b.match(CARD_RE)[1]);
    const cards = await Promise.all(
        names.map(name => orNull(readCard(name, cancellable))));
    return cards.filter(card => card !== null);
}

/**
 * Returns the card at `pdev`, or the one with the most VRAM when `pdev` is
 * empty or not present.
 *
 * @param {GpuCard[]} cards
 * @param {string} pdev
 * @returns {GpuCard|null}
 */
export function pickCard(cards, pdev) {
    const selected = cards.find(card => card.pdev === pdev);
    if (selected)
        return selected;
    return cards.reduce(
        (best, card) => !best || card.vramTotal > best.vramTotal ? card : best,
        null);
}

/**
 * @param {string} value - e.g. "1266528 KiB"; no unit means bytes
 * @returns {number}
 */
function parseSize(value) {
    const match = SIZE_RE.exec(value);
    if (!match)
        return 0;
    return Number(match[1]) * (UNITS[match[2]] ?? 1);
}

function parseFdinfo(text) {
    const fields = new Map();
    for (const line of text.split('\n')) {
        const separator = line.indexOf(':');
        if (separator > 0) {
            fields.set(line.slice(0, separator).trim(),
                line.slice(separator + 1).trim());
        }
    }
    return fields;
}

function memoryField(fields, region) {
    // On some amdgpu kernels drm-memory-* (alias of drm-resident-*) reports
    // more memory than the card has, so it is only a fallback for kernels
    // that predate drm-total-*.
    const value = fields.get(`drm-total-${region}`) ??
        fields.get(`drm-memory-${region}`);
    return value === undefined ? 0 : parseSize(value);
}

async function readClient(pid, fd, cancellable) {
    const fields = parseFdinfo(
        await readText(`/proc/${pid}/fdinfo/${fd}`, cancellable));
    const clientId = fields.get('drm-client-id');
    const pdev = fields.get('drm-pdev');
    if (clientId === undefined || pdev === undefined)
        return null;
    return {
        pid,
        pdev,
        clientId,
        vram: memoryField(fields, 'vram'),
        gtt: memoryField(fields, 'gtt'),
    };
}

async function readProcessClients(pid, cancellable) {
    const fds = await listChildren(`/proc/${pid}/fd`,
        'standard::name,standard::symlink-target', cancellable);
    const drmFds = fds.filter(info =>
        info.has_attribute('standard::symlink-target') &&
        DRI_NODE_RE.test(info.get_symlink_target()));
    return Promise.all(drmFds.map(
        info => orNull(readClient(pid, info.get_name(), cancellable))));
}

/**
 * Lists the readable processes holding memory on the GPU at `pdev`, sorted
 * by decreasing VRAM.
 *
 * @param {string} pdev
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<GpuProcess[]>}
 */
export async function readProcesses(pdev, cancellable = null) {
    const entries = await listChildren('/proc', 'standard::name', cancellable);
    const pids = entries
        .map(info => info.get_name())
        .filter(name => PID_RE.test(name))
        .map(Number);
    const perPid = await Promise.all(
        pids.map(pid => orNull(readProcessClients(pid, cancellable))));

    // Several fds (and sometimes several processes, when an fd is passed
    // around) refer to the same DRM client: count each client once.
    const seen = new Set();
    const processes = new Map();
    for (const client of perPid.flat()) {
        if (!client || client.pdev !== pdev)
            continue;
        const key = `${client.pdev}/${client.clientId}`;
        if (seen.has(key))
            continue;
        seen.add(key);

        let process = processes.get(client.pid);
        if (!process) {
            process = {pid: client.pid, name: '', vram: 0, gtt: 0};
            processes.set(client.pid, process);
        }
        process.vram += client.vram;
        process.gtt += client.gtt;
    }

    const result = [...processes.values()]
        .filter(process => process.vram > 0 || process.gtt > 0);
    await Promise.all(result.map(async process => {
        const comm = await orNull(readText(`/proc/${process.pid}/comm`,
            cancellable));
        process.name = comm?.trim() || String(process.pid);
    }));
    return result.sort((a, b) => b.vram - a.vram || b.gtt - a.gtt);
}
