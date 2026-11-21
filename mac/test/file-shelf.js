// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

const ipcMain = new EventEmitter();
const handles = new Map();
ipcMain.handle = (name, fn) => handles.set(name, fn);
const revealed = [], dragged = [];
let windowId = 0;
class Window extends EventEmitter {
  constructor(opts) {
    super(); this.opts = opts; this.destroyed = false;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, { id: ++windowId, mainFrame: {}, send() {}, setWindowOpenHandler() {}, startDrag(item) { dragged.push(item); } });
  }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  show() { this.shown = true; }
  focus() {}
  close() { this.destroy(); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
const original = Module._load;
Module._load = function(name) {
  if (name === 'electron') return { BrowserWindow: Window, ipcMain,
    screen: { getCursorScreenPoint: () => ({ x: 1, y: 1 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    nativeImage: { createFromPath: () => ({ resize() { return this; }, isEmpty: () => false }) },
    shell: { showItemInFolder: p => revealed.push(p) } };
  return original.apply(this, arguments);
};
const { FileShelf } = require('../file-shelf.js');
Module._load = original;
const event = shelf => ({ sender: shelf.win.webContents, senderFrame: shelf.win.webContents.mainFrame });
const read = shelf => handles.get('file-shelf:read')(event(shelf));
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'twindesk-shelf-test-'));

// The production class handles this end to end, while Electron effects are captured.
test('shelf presents bounded saved files and native drag or reveal only for its own items', () => {
  const dir = tmp();
  const drop = new EventEmitter();
  drop.recent = [];
  try {
    for (let i = 0; i < 12; i++) { const file = path.join(dir, `file-${i}.txt`); fs.writeFileSync(file, 'fixture'); drop.recent.push({ path: file, ok: true }); }
    const shelf = new FileShelf({ drop, latestPhoto: () => ({ path: drop.recent[0].path }) });
    assert.equal(drop.listenerCount('change'), 0);
    shelf.show();
    assert.equal(drop.listenerCount('change'), 1);
    const state = read(shelf);
    assert.equal(state.items.length, 8);
    assert.equal(state.items[0].kind, 'photo');
    assert.equal(new Set(state.items.map(x => x.name)).size, 8, 'latest photo deduplicates Recent');
    assert.ok(state.items.every(item => !('path' in item)));
    const id = state.items[0].id;
    assert.equal(read(shelf).items[0].id, id, 'ordinary refresh retains focus identity');
    ipcMain.emit('file-shelf:drag', event(shelf), id);
    assert.equal(dragged.at(-1).file, drop.recent[0].path);
    ipcMain.emit('file-shelf:reveal', event(shelf), id);
    assert.equal(revealed.at(-1), drop.recent[0].path);
    shelf.refresh();
    assert.equal(read(shelf).items[0].id, id, 'same authorized local file retains focus across refresh');
    shelf.shutdown();
    assert.equal(drop.listenerCount('change'), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shelf refuses foreign frames, revoked photo and replaced or symlinked local files', () => {
  const dir = tmp();
  const drop = new EventEmitter();
  const file = path.join(dir, 'file.txt'), link = path.join(dir, 'link.txt');
  fs.writeFileSync(file, 'original'); fs.symlinkSync(file, link);
  drop.recent = [{ path: link, ok: true }];
  let photo = { path: file };
  const shelf = new FileShelf({ drop, latestPhoto: () => photo });
  const oldDrags = dragged.length, oldReveals = revealed.length;
  try {
    shelf.show();
    const state = read(shelf);
    assert.equal(state.items.length, 1, 'symlink is omitted');
    const id = state.items[0].id;
    const ownEvent = event(shelf);
    ipcMain.emit('file-shelf:drag', { ...ownEvent, senderFrame: {} }, id);
    ipcMain.emit('file-shelf:reveal', { ...ownEvent, sender: { id: -1 } }, id);
    fs.renameSync(file, path.join(dir, 'old.txt')); fs.writeFileSync(file, 'replacement');
    ipcMain.emit('file-shelf:drag', ownEvent, id);
    const replacementId = read(shelf).items[0].id;
    photo = null;
    ipcMain.emit('file-shelf:reveal', ownEvent, replacementId);
    assert.equal(dragged.length, oldDrags);
    assert.equal(revealed.length, oldReveals);
    assert.equal(read(shelf).items.length, 0, 'revoked item leaves the shelf');
    shelf.shutdown();
    assert.equal(handles.get('file-shelf:read')(ownEvent), null, 'retired contents cannot read shelf');
  } finally { shelf.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

const wire = require('../../shared/localsend/wire.js');
const TL = require('../../shared/timeline.js');
const root = path.join(__dirname, '../..');
const ACTIONS = ['lsSet', 'lsRefresh', 'lsAdd', 'lsChoose', 'lsSend', 'lsPin', 'lsAnswer', 'lsCancel', 'lsClear', 'lsReveal'];

test('completed LocalSend receipts show on the shelf and in activity from history', () => {
  const dir = tmp();
  const drop = new EventEmitter();
  const now = Date.now();
  const dup = path.join(dir, 'same.txt');
  const received = path.join(dir, 'from-phone.txt');
  const second = path.join(dir, 'notes.txt');
  const folder = path.join(dir, 'album');
  const older = path.join(dir, 'older.txt');
  fs.writeFileSync(dup, 'both');
  fs.writeFileSync(received, 'incoming');
  fs.writeFileSync(second, 'second');
  fs.mkdirSync(folder);
  fs.writeFileSync(older, 'drop');
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'not a receipt');
  drop.recent = [
    { path: dup, ok: true, at: now - 500 },
    { path: older, ok: true, at: now - 1000 },
  ];
  const transfers = [
    { id: 'in-new', dir: 'in', state: 'done', at: now, saved: [received, second, dup], peer: { alias: 'Pixel', ip: '10.1.1.1', fingerprint: 'fp-secret' } },
    { id: 'in-folder', dir: 'in', state: 'done', at: now - 50, saved: [folder], peer: { alias: 'Pixel', fingerprint: 'fp-secret' } },
    { id: 'in-older', dir: 'in', state: 'done', at: now - 1000, saved: [older], peer: { alias: 'Pixel', fingerprint: 'fp-secret' } },
    { id: 'in-dup', dir: 'in', state: 'done', at: now - 10, saved: [received] },
    { id: 'out-1', dir: 'out', state: 'done', at: now + 5000, saved: [older], peer: { alias: 'Elsewhere', ip: '10.9.9.9', fingerprint: 'fp-out' } },
    { id: 'run-1', dir: 'in', state: 'running', at: now + 4000, names: ['busy.bin'], peer: { alias: 'Busy', fingerprint: 'fp-run', ip: '10.4.4.4' } },
  ];
  let list = wire.completedIncoming(transfers);
  const shelf = new FileShelf({ drop, latestPhoto: () => ({ path: dup }), receipts: () => list, t: (s) => s });
  try {
    assert.deepEqual(list.map((item) => item.path), [received, second, dup, folder, older]);
    assert.equal(list[0].identity.folder, false);
    assert.equal(list[3].identity.folder, true);
    assert.ok(!JSON.stringify(list).includes('fp-secret') && !JSON.stringify(list).includes('10.1.1.1'));
    assert.deepEqual(wire.ACTIONS, ACTIONS);
    shelf.show();
    const state = read(shelf);
    assert.deepEqual(state.items.map((item) => item.name), ['same.txt', 'from-phone.txt', 'notes.txt', 'album', 'older.txt']);
    assert.equal(state.items[0].kind, 'photo');
    assert.equal(state.items[3].kind, 'folder');
    assert.ok(state.items.every((item) => !('path' in item) && !JSON.stringify(item).includes(dir)));
    assert.deepEqual(Object.keys(state.items[1]).sort(), ['extension', 'id', 'kind', 'name', 'size']);
    const ids = state.items.map((item) => item.id);
    assert.deepEqual(read(shelf).items.map((item) => item.id), ids, 'refresh keeps shelf focus');
    shelf.refresh();
    assert.deepEqual(read(shelf).items.map((item) => item.id), ids);
    const photoId = ids[0];
    ipcMain.emit('file-shelf:drag', event(shelf), ids[1]);
    assert.equal(dragged.at(-1).file, received);
    ipcMain.emit('file-shelf:reveal', event(shelf), ids[3]);
    assert.equal(revealed.at(-1), folder);
    const opened = [];
    assert.equal(wire.openReceipt(transfers, { id: 'in-new', index: 0, path: folder }, (p) => opened.push(p)), true);
    assert.equal(wire.openReceipt(transfers, { id: 'in-new', index: 1, path: '/etc/passwd' }, (p) => opened.push(p)), true);
    assert.deepEqual(opened, [received, second]);

    const shown = TL.build({
      files: { recent: [{ name: 'older.txt', path: older, at: now - 1000, ok: true }] },
      localsend: { transfers },
    });
    const files = shown.filter((item) => item.kind === 'file');
    const olderItem = files.find((item) => item.path === older);
    const incoming = files.find((item) => item.path === received);
    const notes = files.find((item) => item.path === second);
    assert.equal(files.filter((item) => item.path === older).length, 1, 'TwinDesk already owns this path');
    assert.equal(olderItem.meta.ls, undefined);
    assert.equal(incoming.meta.ls, 'in-new');
    assert.equal(incoming.peer, 'Pixel');
    assert.equal(notes.meta.lsIndex, 1);
    assert.equal(files.filter((item) => item.path === received).length, 1);
    assert.ok(!files.some((item) => item.title === 'busy.bin'));
    const blob = JSON.stringify(files);
    for (const secret of ['fp-secret', 'fp-out', 'fp-run', '10.1.1.1', '10.9.9.9', '10.4.4.4']) assert.ok(!blob.includes(secret), secret);
    assert.deepEqual(TL.localsendReveal(incoming, transfers), { id: 'in-new' });
    assert.deepEqual(TL.localsendReveal(notes, transfers), { id: 'in-new', index: 1 });
    assert.equal('path' in TL.localsendReveal(notes, transfers), false);
    const owned = TL.build({ localsend: { transfers } }).find((item) => item.path === older);
    assert.equal(owned.meta.ls, 'in-older', 'clearing TwinDesk recent leaves the LocalSend receipt');
    assert.equal(TL.localsendReveal(incoming, []), null);

    const realFolder = path.join(dir, 'downloads-real');
    const downloads = path.join(dir, 'Downloads');
    fs.mkdirSync(realFolder);
    fs.symlinkSync(realFolder, downloads);
    const viaLink = path.join(downloads, 'via.txt');
    fs.writeFileSync(viaLink, 'via');
    const viaCanonical = fs.realpathSync(viaLink);
    const viaTransfers = [{ id: 'via', dir: 'in', state: 'done', at: now + 50, saved: [viaLink], peer: { alias: 'Pixel', fingerprint: 'fp-via' } }];
    const viaList = wire.completedIncoming(viaTransfers, { receivedDir: downloads });
    assert.equal(viaList.length, 1);
    assert.equal(viaList[0].path, viaCanonical);
    assert.notEqual(viaList[0].path, viaLink);
    const viaOpened = [];
    assert.equal(wire.openReceipt(viaTransfers, 'via', (p) => viaOpened.push(p), { receivedDir: downloads }), true);
    assert.deepEqual(viaOpened, [viaCanonical]);
    list = viaList;
    drop.recent = [];
    const viaState = read(shelf);
    assert.deepEqual(viaState.items.map((item) => item.name), ['same.txt', 'via.txt']);
    assert.equal(viaState.items[0].id, photoId);
    ipcMain.emit('file-shelf:drag', event(shelf), viaState.items[1].id);
    assert.equal(dragged.at(-1).file, viaCanonical);
    ipcMain.emit('file-shelf:reveal', event(shelf), viaState.items[1].id);
    assert.equal(revealed.at(-1), viaCanonical);
    if (process.platform !== 'linux') {
      const lowerDir = path.join(dir, 'downloads');
      const lowerFile = path.join(lowerDir, 'via.txt');
      const cased = wire.completedIncoming(
        [{ id: 'case', dir: 'in', state: 'done', at: now, saved: [lowerFile] }],
        { receivedDir: lowerDir },
      );
      let realLower = '';
      try { realLower = fs.realpathSync(lowerFile); } catch { realLower = ''; }
      if (realLower && realLower !== lowerFile) assert.equal(cased[0] && cased[0].path, realLower);
    }

    const many = [];
    for (let i = 0; i < 12; i++) {
      const file = path.join(dir, `many-${i}.txt`);
      fs.writeFileSync(file, 'm' + i);
      many.push({ path: file, at: now + 10 + i });
    }
    list = many;
    drop.recent = [];
    const bounded = read(shelf);
    assert.equal(bounded.items.length, 8);
    assert.equal(bounded.items[0].id, photoId);
    assert.deepEqual(bounded.items.slice(1).map((item) => item.name), [11, 10, 9, 8, 7, 6, 5].map((i) => `many-${i}.txt`));
    const boundedIds = bounded.items.map((item) => item.id);
    shelf.refresh();
    assert.deepEqual(read(shelf).items.map((item) => item.id), boundedIds);
    for (const rel of ['mac/main.js', 'mac/mesh/main.js']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.match(src, /localsend && localsend\.receipts/);
      assert.match(src, /fileShelf\?\.refresh\(\)/);
    }
    for (const rel of ['mac/ui-timeline.js', 'shared/ui-timeline.js']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.match(src, /localsendReveal/);
      assert.match(src, /if \(m\.ls\)/);
      assert.doesNotMatch(src, /lsReveal\(\s*it\.path/);
    }
    shelf.shutdown();
  } finally { shelf.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unfinished, linked, cleared and supplied LocalSend paths are not revealed', () => {
  const dir = tmp();
  const drop = new EventEmitter();
  const now = Date.now();
  const real = path.join(dir, 'real.txt');
  const link = path.join(dir, 'link.txt');
  const dropFile = path.join(dir, 'drop.txt');
  fs.writeFileSync(real, 'real');
  fs.writeFileSync(dropFile, 'drop');
  fs.symlinkSync(real, link);
  const transfers = [
    { id: 'in-real', dir: 'in', state: 'done', at: now, saved: [real, link, 'relative.txt'], peer: { alias: 'Pixel', ip: '10.0.0.2', fingerprint: 'fp-secret' } },
    { id: 'out', dir: 'out', state: 'done', at: now + 5, saved: [dropFile], peer: { alias: 'Elsewhere', fingerprint: 'fp-out', ip: '8.8.8.8' } },
    { id: 'run', dir: 'in', state: 'running', at: now + 4, saved: [real], peer: { fingerprint: 'fp-run' } },
    { id: 'stop', dir: 'in', state: 'cancelled', at: now + 3, saved: [dropFile], arrived: 1, peer: { fingerprint: 'fp-stop' } },
  ];
  let list = wire.completedIncoming(transfers);
  assert.deepEqual(list.map((item) => item.path), [real], 'a linked saved path is not an eligible receipt');
  const missing = [];
  for (let i = 0; i < 40; i++) missing.push(path.join(dir, 'missing', `m-${i}.txt`));
  assert.deepEqual(wire.completedIncoming([
    { id: 'gone', dir: 'in', state: 'done', at: now + 20, saved: missing },
    { id: 'in-real', dir: 'in', state: 'done', at: now, saved: [real] },
  ]).map((item) => item.path), [real], 'missing newest files do not take the receipt places');
  const large = [{ id: 'large', dir: 'in', state: 'done', at: now, saved: [...missing, real] }];
  assert.deepEqual(wire.completedIncoming(large).map((item) => item.path), [real]);
  const unavailable = { receivedDir: path.join(dir, 'unavailable') };
  assert.deepEqual(wire.completedIncoming(large, unavailable), []);
  assert.equal(wire.openReceipt(large, { id: 'large', index: 40 }, () => assert.fail(), unavailable), false);
  const before = path.join(dir, 'before.txt');
  fs.writeFileSync(before, 'original');
  const stamped = wire.completedIncoming([{ id: 'before', dir: 'in', state: 'done', at: now + 1, saved: [before] }]);
  fs.renameSync(before, path.join(dir, 'before-original.txt'));
  fs.writeFileSync(before, 'replaced-before-open');
  const earlyDrop = new EventEmitter();
  earlyDrop.recent = [];
  const early = new FileShelf({ drop: earlyDrop, latestPhoto: () => null, receipts: () => stamped });
  early.show();
  assert.deepEqual(read(early).items, [], 'a file replaced before the shelf opens is not admitted');
  early.shutdown();
  const box = path.join(dir, 'box');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(box);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  const linkedBox = path.join(box, 'album');
  fs.symlinkSync(outside, linkedBox);
  const nested = path.join(linkedBox, 'secret.txt');
  const boxed = [{ id: 'box', dir: 'in', state: 'done', at: now, saved: [nested] }];
  assert.deepEqual(wire.completedIncoming(boxed, { receivedDir: box }), []);
  assert.equal(wire.openReceipt(boxed, 'box', () => {}), false);
  const saveReal = path.join(dir, 'save-real');
  const saveLink = path.join(dir, 'save-link');
  fs.mkdirSync(saveReal);
  fs.symlinkSync(saveReal, saveLink);
  const partialFile = path.join(saveLink, 'partial.txt');
  fs.writeFileSync(partialFile, 'part');
  const partialOpened = [];
  assert.equal(wire.openReceipt(
    [{ id: 'part', dir: 'in', state: 'cancelled', at: now, saved: [partialFile], arrived: 1 }],
    'part',
    (p) => partialOpened.push(p),
    { receivedDir: saveLink },
  ), true);
  assert.deepEqual(partialOpened, [fs.realpathSync(partialFile)], 'a partial file in a linked save folder still opens');
  let boom = false;
  drop.recent = [{ path: dropFile, ok: true, at: now - 10 }];
  const shelf = new FileShelf({
    drop, latestPhoto: () => null,
    receipts: () => { if (boom) throw new Error('history'); return list; },
  });
  const beforeDrag = dragged.length, beforeReveal = revealed.length;
  try {
    shelf.show();
    const state = read(shelf);
    assert.deepEqual(state.items.map((item) => item.name), ['real.txt', 'drop.txt']);
    assert.ok(!JSON.stringify(state).includes('fp-secret'));
    const id = state.items[0].id;
    const dropId = state.items[1].id;
    const own = event(shelf);
    ipcMain.emit('file-shelf:drag', { ...own, senderFrame: {} }, id);
    ipcMain.emit('file-shelf:reveal', { ...own, sender: { id: -1 } }, id);
    fs.renameSync(real, path.join(dir, 'real-original.txt'));
    fs.writeFileSync(real, 'replaced-contents');
    ipcMain.emit('file-shelf:drag', own, id);
    ipcMain.emit('file-shelf:reveal', own, id);
    assert.equal(dragged.length, beforeDrag);
    assert.equal(revealed.length, beforeReveal);
    assert.deepEqual(read(shelf).items.map((item) => item.name), ['drop.txt'], 'a replacement is not admitted on refresh');
    list = [];
    const left = read(shelf);
    assert.deepEqual(left.items.map((item) => item.name), ['drop.txt'], 'cleared history is not replaced by a folder scan');
    assert.equal(left.items[0].id, dropId);
    ipcMain.emit('file-shelf:drag', own, dropId);
    assert.equal(dragged.at(-1).file, dropFile);
    const drags = dragged.length;
    ipcMain.emit('file-shelf:reveal', own, id);
    assert.equal(revealed.length, beforeReveal);
    assert.equal(dragged.length, drags);
    boom = true;
    assert.doesNotThrow(() => read(shelf));
    assert.deepEqual(read(shelf).items.map((item) => item.name), ['drop.txt']);

    const files = TL.build({ localsend: { transfers } }).filter((item) => item.kind === 'file');
    assert.deepEqual(files.map((item) => item.title), ['real.txt', 'link.txt']);
    const blob = JSON.stringify(files);
    for (const secret of ['fp-secret', 'fp-out', 'fp-run', 'fp-stop', '10.0.0.2', '8.8.8.8', 'relative.txt']) assert.ok(!blob.includes(secret), secret);
    const linkItem = files[1];
    assert.equal(TL.localsendReveal(files[0], []), null);
    assert.equal(TL.localsendReveal({ ...files[0], path: dropFile }, transfers), null);
    assert.equal(TL.localsendReveal({ ...files[0], meta: { ...files[0].meta, lsIndex: 1.5 } }, transfers), null);
    assert.deepEqual(TL.localsendReveal(linkItem, transfers), { id: 'in-real', index: 1 });
    const opened = [];
    assert.equal(wire.openReceipt(transfers, TL.localsendReveal(linkItem, transfers), (p) => opened.push(p)), false);
    assert.equal(wire.openReceipt(transfers, TL.localsendReveal(linkItem, transfers), (p) => opened.push(p), { receivedDir: dir }), false);
    assert.equal(wire.openReceipt(transfers, { id: 'out', path: real }, (p) => opened.push(p)), false);
    assert.equal(wire.openReceipt(transfers, { id: 'run', path: real }, (p) => opened.push(p)), false);
    assert.equal(wire.openReceipt(transfers, { id: 'stop', path: '/etc/passwd' }, (p) => opened.push(p)), true);
    assert.deepEqual(opened, [dropFile], 'a finished partial save still opens its own file');
    opened.length = 0;
    assert.equal(wire.openReceipt(transfers, { id: 'missing', path: real }, (p) => opened.push(p)), false);
    assert.equal(wire.openReceipt(transfers, { id: 'in-real', index: 9, path: real }, (p) => opened.push(p)), false);
    assert.deepEqual(opened, []);
    const leaked = [];
    const service = wire.startLocalSend({
      dir: path.join(dir, 'data'),
      settings: () => ({ localsend: { on: false } }),
      pushState() {}, save() {}, name: () => 'Fixture', receivedDir: () => dir,
      reveal: (p) => leaked.push(p),
      core: { host: '127.0.0.1', port: 0, multicast: false },
    });
    try {
      service.actions.lsReveal({ id: 'in-real', index: 0, path: real });
      assert.deepEqual(leaked, []);
      assert.deepEqual(service.receipts, []);
    } finally { service.shutdown(); }
    shelf.shutdown();
  } finally { shelf.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('edited LocalSend receipts can still be dragged and revealed', () => {
  const dir = tmp();
  const folder = path.join(dir, 'album');
  const file = path.join(dir, 'notes.txt');
  const child = path.join(folder, 'a.txt');
  fs.mkdirSync(folder);
  fs.writeFileSync(child, 'photo');
  fs.writeFileSync(file, 'notes');
  const transfers = [{ id: 'receipt', dir: 'in', state: 'done', saved: [folder, file] }];
  const rows = wire.completedIncoming(transfers, { receivedDir: dir });
  const pins = new Map([['receipt', rows.map(row => ({ canonical: row.path, root: dir, identity: row.identity }))]]);
  const shelf = new FileShelf({ receipts: () => wire.completedIncoming(transfers, { pins }) });
  try {
    shelf.show();
    fs.writeFileSync(path.join(folder, '.DS_Store'), 'finder');
    fs.unlinkSync(child);
    fs.appendFileSync(file, ' edited');
    const { items } = read(shelf);
    assert.deepEqual(items.map(item => [item.name, item.size]), [['album', null], ['notes.txt', 12]]);
    for (const [index, saved] of [folder, file].entries()) {
      ipcMain.emit('file-shelf:drag', event(shelf), items[index].id);
      ipcMain.emit('file-shelf:reveal', event(shelf), items[index].id);
      assert.equal(dragged.at(-1).file, saved);
      assert.equal(revealed.at(-1), saved);
    }
  } finally {
    shelf.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
