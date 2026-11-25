// TwinDesk — GPL-3.0, see LICENSE.
'use strict';

const { execFile, spawn } = require('node:child_process');
const { randomInt, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');
const { Mux } = require('../shared/iosnet');

const exec = promisify(execFile);
const RUNNER_ID = 'net.waypair.twindesk.ipadcontrol.wda';
const UDID = /^[\da-f]{8}-[\da-f]{16}$/i;
const BUILD_PIN = '30aac069ecf7891fe1673482d3e962b181e714b5';

async function developerIPads(signal) {
  const { stdout } = await exec('/usr/bin/xcrun', ['devicectl', 'list', 'devices', '-q',
    '--timeout', '8', '--json-output', '/dev/stdout'], { signal, timeout: 9000 });
  return JSON.parse(stdout).result.devices.flatMap((d) => {
    const udid = d.hardwareProperties?.udid;
    if (!UDID.test(udid) || d.hardwareProperties.deviceType !== 'iPad'
        || d.connectionProperties?.pairingState !== 'paired') return [];
    return [{ udid: udid.toUpperCase(), name: String(d.deviceProperties?.name || 'iPad').slice(0, 80),
      developerMode: d.deviceProperties?.developerModeStatus === 'enabled' }];
  });
}

function muxRequest(message, take, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const mux = new Mux();
    const cancel = () => mux.close();
    signal.addEventListener('abort', cancel, { once: true });
    const detach = () => signal.removeEventListener('abort', cancel);
    mux.on('error', reject);
    mux.once('close', () => { detach(); reject(new Error('usbmux closed')); });
    mux.once('open', () => mux.send(message));
    mux.once('message', (reply, rest) => {
      try {
        const raw = take(reply);
        if (raw) {
          mux.sock.pause();
          mux.raw = true;
          detach();
          if (rest.length) mux.sock.unshift(rest);
          resolve(mux.sock);
        } else {
          resolve(reply);
          mux.close();
        }
      } catch (error) {
        reject(error);
        mux.close();
      }
    });
  });
}

async function muxDevice(udid, signal) {
  const { DeviceList } = await muxRequest({ MessageType: 'ListDevices' }, () => false, signal);
  return DeviceList?.find((d) => d.Properties?.SerialNumber?.toUpperCase() === udid
    && ['USB', 'Network'].includes(d.Properties.ConnectionType) && Number.isInteger(d.DeviceID));
}

function requestWda(agent, method, route, body, signal, timeout) {
  return new Promise((resolve, reject) => {
    const data = body == null ? undefined : JSON.stringify(body);
    const req = http.request({
      agent, hostname: '127.0.0.1', method, path: route, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: data == null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('error', reject);
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > 64 * 1024) req.destroy(new Error('WDA response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('WDA rejected command');
          if (route === '/wda/shutdown') return resolve();
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (payload.value?.error || payload.status > 0) throw new Error('WDA rejected command');
          resolve(payload);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Xcode owns installation and XCTest. Each connection uses the existing usbmux pairing directly.
// No TCP listener on the Mac, including during startup. The exact peer must be visible to usbmux.
async function startXCTest(udid, signal) {
  const template = process.env.TWINDESK_IPAD_WDA_XCTESTRUN;
  if (!template || !path.isAbsolute(template)) throw new Error('setup');
  if (!UDID.test(udid)) throw new Error('device');
  const device = (await developerIPads(signal)).find((d) => d.udid === udid);
  if (!device) throw new Error('device');
  if (!device.developerMode) throw new Error('developerMode');
  if (!await muxDevice(udid, AbortSignal.any([signal, AbortSignal.timeout(2000)]))) throw new Error('route');

  const marker = `${BUILD_PIN}:${randomUUID()}`;
  const port = randomInt(54000, 64000);
  const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', template], { signal, timeout: 3000 });
  const run = JSON.parse(stdout);
  const runner = run.WebDriverAgentRunner;
  if (run.__xctestrun_metadata__?.FormatVersion !== 1 || Object.keys(run).length !== 2 ||
      runner?.TestHostBundleIdentifier !== `${RUNNER_ID}.xctrunner`) throw new Error('setup');
  const env = runner.EnvironmentVariables;
  if (!env || runner.CommandLineArguments?.length) throw new Error('setup');
  delete env.ENABLE_AUTOMATIC_SCREENSHOTS;
  delete env.ENABLE_AUTOMATIC_SCREEN_RECORDINGS;
  Object.assign(env, { USE_IP: '127.0.0.1', USE_PORT: String(port), MJPEG_SERVER_PORT: '0',
    WDA_PRODUCT_BUNDLE_IDENTIFIER: RUNNER_ID, UPGRADE_TIMESTAMP: marker });

  // __TESTROOT__ in the generated manifest is relative to the xctestrun file.
  const runFile = path.join(path.dirname(template), `.twindesk-${randomUUID()}.xctestrun`);
  const resultPath = runFile.replace(/\.xctestrun$/, '.xcresult');
  try {
    await fs.writeFile(runFile, JSON.stringify(run), { flag: 'wx', mode: 0o600, signal });
    await exec('/usr/bin/plutil', ['-convert', 'xml1', runFile], { signal, timeout: 3000 });
    signal.throwIfAborted();
  } catch (error) {
    await fs.rm(runFile, { force: true });
    throw error;
  }

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const closeDial = new AbortController();
  const lost = new AbortController();
  let sealed = false;
  agent.createConnection = (_options, callback) => {
    if (sealed) return callback(new Error('WDA connection closed'));
    const deadline = AbortSignal.any([closeDial.signal, AbortSignal.timeout(1500)]);
    (async () => {
      const target = await muxDevice(udid, deadline);
      if (!target) throw new Error('route');
      return muxRequest({ MessageType: 'Connect', DeviceID: target.DeviceID, PortNumber: ((port & 255) << 8) | (port >> 8) },
        (reply) => {
          if (reply.MessageType !== 'Result' || reply.Number !== 0) throw new Error('WDA port unavailable');
          return true;
        }, deadline);
    })().then((socket) => {
      if (closeDial.signal.aborted) {
        socket.destroy();
        return callback(new Error('WDA connection closed'));
      }
      socket.once('close', () => { if (sealed) lost.abort(); });
      callback(null, socket);
      socket.resume();
    }, callback);
  };

  const child = spawn('/usr/bin/xcrun', ['xcodebuild', 'test-without-building', '-xctestrun', runFile,
    '-destination', `platform=iOS,id=${udid}`, '-parallel-testing-enabled', 'NO',
    '-resultBundlePath', resultPath], { stdio: 'ignore' });
  const exited = new Promise((resolve) => {
    child.once('error', resolve);
    child.once('exit', resolve);
  });
  let stopping;
  return {
    marker, exited, lost: lost.signal,
    seal: () => { sealed = true; },
    request: (method, route, body, abort, timeout = 3200) => requestWda(agent, method, route, body, abort, timeout),
    stop: () => stopping ||= (async () => {
      closeDial.abort();
      agent.destroy();
      child.kill('SIGINT');
      const force = setTimeout(() => child.kill('SIGKILL'), 2200);
      force.unref();
      await exited;
      clearTimeout(force);
      await Promise.allSettled([fs.rm(runFile, { force: true }), fs.rm(resultPath, { recursive: true, force: true })]);
    })(),
  };
}

module.exports = { developerIPads, startXCTest, RUNNER_ID };
