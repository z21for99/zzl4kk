const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { WebSocketServer } = require('ws');

const PORT = process.env.SYNC_PORT || 9876;
const WATCH_DIR = process.env.SYNC_DIR || __dirname;
const WATCH_PATTERN = '*.js';

// Track which files were recently written by us (to prevent echo loops)
const recentlyWritten = new Map();

function getFileList() {
  return fs.readdirSync(WATCH_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();
}

function readFile(filename) {
  const filePath = path.join(WATCH_DIR, filename);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return null;
  }
}

function writeFile(filename, content) {
  const filePath = path.join(WATCH_DIR, filename);
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    recentlyWritten.set(filename, Date.now());
  } catch (err) {
    console.error(`[sync-server] Error writing ${filename}:`, err.message);
  }
}

// --- WebSocket Server ---
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

console.log(`[sync-server] Watching: ${WATCH_DIR}`);
console.log(`[sync-server] WebSocket listening on ws://127.0.0.1:${PORT}`);

wss.on('connection', (ws) => {
  console.log('[sync-server] Browser connected');

  // Send file list on connect
  const files = getFileList();
  ws.send(JSON.stringify({ type: 'file_list', files }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'list_files':
          ws.send(JSON.stringify({ type: 'file_list', files: getFileList() }));
          break;

        case 'request_file':
          {
            const content = readFile(msg.file);
            if (content !== null) {
              ws.send(JSON.stringify({ type: 'file_changed', file: msg.file, content }));
            }
          }
          break;

        case 'error_log':
          // Write error events to log file for debugging
          if (msg.file && msg.errorType && msg.detail) {
            const logDir = path.join(WATCH_DIR, 'logs');
            if (!fs.existsSync(logDir)) {
              fs.mkdirSync(logDir, { recursive: true });
            }
            const now = new Date();
            const ts = now.getFullYear() + '-' +
              String(now.getMonth() + 1).padStart(2, '0') + '-' +
              String(now.getDate()).padStart(2, '0') + ' ' +
              String(now.getHours()).padStart(2, '0') + ':' +
              String(now.getMinutes()).padStart(2, '0') + ':' +
              String(now.getSeconds()).padStart(2, '0');
            const line = '[' + ts + '] [file: ' + msg.file + '] ' +
              msg.errorType + ': ' + msg.detail + '\n';
            const logPath = path.join(logDir, 'sync-errors.log');
            fs.appendFileSync(logPath, line, 'utf-8');
            console.log('[sync-server] Error logged: ' + msg.errorType);
          }
          break;

        case 'save_backup':
          // Save a snapshot of Wix IDE content before overwriting
          if (msg.file && msg.content !== undefined) {
            const backupDir = path.join(WATCH_DIR, 'backups');
            if (!fs.existsSync(backupDir)) {
              fs.mkdirSync(backupDir, { recursive: true });
            }
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const ts = now.getFullYear() +
              pad(now.getMonth() + 1) +
              pad(now.getDate()) + '-' +
              pad(now.getHours()) +
              pad(now.getMinutes()) +
              pad(now.getSeconds());
            const backupName = msg.file + '--' + ts + '.js';
            const backupPath = path.join(backupDir, backupName);
            fs.writeFileSync(backupPath, msg.content, 'utf-8');
            console.log('[sync-server] Backup saved: ' + backupName);
          }
          break;

        case 'list_backups':
          // Return backup files for a specific source file
          {
            const backupDir = path.join(WATCH_DIR, 'backups');
            const prefix = msg.file ? (msg.file + '--') : '';
            let backups = [];
            if (fs.existsSync(backupDir)) {
              backups = fs.readdirSync(backupDir)
                .filter(f => !prefix || f.startsWith(prefix))
                .sort()
                .reverse(); // newest first
            }
            ws.send(JSON.stringify({
              type: 'backup_list',
              file: msg.file,
              backups: backups
            }));
          }
          break;

        case 'read_backup':
          // Read content of a specific backup file
          {
            const backupDir = path.join(WATCH_DIR, 'backups');
            const backupPath = path.join(backupDir, msg.backupName);
            let content = null;
            try {
              content = fs.readFileSync(backupPath, 'utf-8');
            } catch (err) {
              content = null;
            }
            ws.send(JSON.stringify({
              type: 'backup_content',
              backupName: msg.backupName,
              content: content
            }));
          }
          break;

        case 'content_update':
          // Browser sent an edit — write to local file
          if (msg.file && msg.content !== undefined) {
            writeFile(msg.file, msg.content);
          }
          break;
      }
    } catch (err) {
      console.error('[sync-server] Invalid message:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[sync-server] Browser disconnected');
  });
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[sync-server] Port ${PORT} is already in use.`);
    console.error(`[sync-server] Try: npx kill-port ${PORT}`);
  } else {
    console.error('[sync-server] WebSocket error:', err.message);
  }
  process.exit(1);
});

// --- File Watcher ---
const watcher = chokidar.watch(path.join(WATCH_DIR, WATCH_PATTERN), {
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
});

watcher.on('change', (filePath) => {
  const filename = path.basename(filePath);

  // Skip if we just wrote this file (echo loop prevention)
  const lastWritten = recentlyWritten.get(filename);
  if (lastWritten && Date.now() - lastWritten < 500) {
    return;
  }

  const content = readFile(filename);
  if (content === null) return;

  const msg = JSON.stringify({ type: 'file_changed', file: filename, content });

  let clients = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
      clients++;
    }
  });

  console.log(`[sync-server] ${filename} changed → pushed to ${clients} client(s)`);
});

console.log('[sync-server] Ready. Edit .js files in VSCode and they will sync to Wix IDE.');
