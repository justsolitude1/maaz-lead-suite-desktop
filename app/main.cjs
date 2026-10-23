const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const APP_TITLE = 'Maaz Lead Suite';
const processes = [];
let mainWindow;
let shuttingDown = false;

function resource(...parts) {
  return path.join(process.resourcesPath, ...parts);
}

function logFile() {
  const base = process.env.LOCALAPPDATA || app.getPath('userData');
  const folder = path.join(base, 'MaazLeadSuite', 'logs');
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, 'desktop.log');
}

function appendLog(text) {
  try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${text}\n`); } catch {}
}

function startService(label, script, env) {
  const node = resource('runtime', 'node.exe');
  const child = spawn(node, [script], {
    cwd: path.dirname(script),
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processes.push(child);
  child.stdout.on('data', data => appendLog(`${label}: ${data.toString().trimEnd()}`));
  child.stderr.on('data', data => appendLog(`${label} error: ${data.toString().trimEnd()}`));
  child.on('error', error => appendLog(`${label} launch error: ${error.message}`));
  child.on('exit', (code, signal) => {
    appendLog(`${label} exited code=${code} signal=${signal}`);
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: `${APP_TITLE} service stopped`,
        message: `${label} stopped unexpectedly. Close and reopen Maaz Lead Suite.`,
        detail: `Details: ${logFile()}`
      });
    }
  });
  return child;
}

function waitForHttp(url, label, child) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error(`${label} stopped while starting.`));
      const request = http.get(url, response => {
        response.resume();
        resolve();
      });
      request.on('error', () => {
        if (Date.now() - started > 30000) return reject(new Error(`${label} did not start at ${url}.`));
        setTimeout(attempt, 350);
      });
      request.setTimeout(1000, () => request.destroy());
    };
    attempt();
  });
}

function assertPortFree(port, label) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is already in use (${label}).`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: APP_TITLE,
    backgroundColor: '#f4f6f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  mainWindow.loadFile(path.join(__dirname, 'shell.html'));
}

async function boot() {
  try {
    await Promise.all([assertPortFree(4173, 'LeadKing'), assertPortFree(3000, 'Postbox')]);
    const base = process.env.LOCALAPPDATA || app.getPath('userData');
    const dataRoot = path.join(base, 'MaazLeadSuite');
    const leadkingState = path.join(dataRoot, 'LeadKing');
    const postboxState = path.join(dataRoot, 'Postbox');
    fs.mkdirSync(path.join(leadkingState, 'exports'), { recursive: true });
    fs.mkdirSync(postboxState, { recursive: true });

    const leadking = startService('LeadKing', resource('apps', 'leadking', 'server.mjs'), {
      LEADKING_PORT: '4173',
      LEADKING_HOST: '127.0.0.1',
      LEADKING_DATA_DIR: leadkingState,
      LEADKING_EXPORT_DIR: path.join(leadkingState, 'exports')
    });
    const postbox = startService('Postbox', resource('apps', 'postbox', 'server.mjs'), {
      PORT: '3000',
      APP_ORIGIN: 'http://localhost:3000',
      POSTBOX_HOST: 'localhost',
      POSTBOX_DATA_DIR: postboxState,
      POSTBOX_REFERENCE_DIR: resource('apps', 'postbox', 'data')
    });

    await Promise.all([
      waitForHttp('http://127.0.0.1:4173/', 'LeadKing', leadking),
      waitForHttp('http://localhost:3000/api/status', 'Postbox', postbox)
    ]);
    createWindow();
  } catch (error) {
    appendLog(`Startup error: ${error.stack || error}`);
    await dialog.showMessageBox({
      type: 'error',
      title: `${APP_TITLE} could not start`,
      message: error.message,
      detail: `Check whether ports 3000 or 4173 are already in use. Log: ${logFile()}`
    });
    app.quit();
  }
}

app.whenReady().then(boot);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
  shuttingDown = true;
  for (const child of processes) {
    try { child.kill(); } catch {}
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
