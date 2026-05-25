// ==UserScript==
// @name         Wix IDE Sync
// @namespace    wix-sync
// @version      2.1
// @description  Semi-automatic sync between local VSCode files and Wix online IDE
// @author       You
// @match        https://ide.wix-code.com/*
// @match        https://*.wix-code.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var WS_URL = 'ws://127.0.0.1:9876';
  var RECONNECT_DELAY = 3000;
  var BACKUP_TIMEOUT = 8000;
  var PASTE_TIMEOUT = 8000;

  var isTopWindow = (window === window.top);
  var isWebWorker = location.href.indexOf('webWorkerExtensionHostIframe') !== -1;

  // =========================================================================
  //  TOP WINDOW — WebSocket + Panel + Sync orchestration
  // =========================================================================
  if (isTopWindow) {

    var ws = null;
    var fileList = [];
    var mappedFile = null;
    var pendingContent = null;
    var targetIframe = null;
    var syncing = false;
    var originalClipboard = null;
    var backupTimer = null;
    var pasteTimer = null;

    function isEditorFrame() {
      return location.href.indexOf('ide.wix-code.com') !== -1;
    }

    function logError(errorType, detail) {
      console.error('[Wix Sync] ERROR:', errorType, '-', detail);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'error_log',
          file: mappedFile ? mappedFile.localFile : '(none)',
          errorType: errorType,
          detail: detail
        }));
      }
    }

    function clearTimers() {
      if (backupTimer) { clearTimeout(backupTimer); backupTimer = null; }
      if (pasteTimer)  { clearTimeout(pasteTimer);  pasteTimer = null; }
    }

    function abortSync(reason, logType) {
      clearTimers();
      logError(logType, reason);
      syncing = false;
      restoreClipboard();
      updateSyncButton();
      setStatus('d', reason);
    }

    function saveClipboard() {
      originalClipboard = null;
      try {
        navigator.clipboard.readText().then(function (text) {
          originalClipboard = text;
        }).catch(function () {});
      } catch (e) {}
    }

    function restoreClipboard() {
      if (originalClipboard !== null) {
        try {
          navigator.clipboard.writeText(originalClipboard).catch(function () {});
        } catch (e) {}
        originalClipboard = null;
      }
    }

    function createPanel() {
      if (!document.body) { setTimeout(createPanel, 500); return; }
      try {
        var el = document.createElement('div');
        el.id = 'wix-sync-panel';
        el.innerHTML = '<style>' +
          '#wix-sync-panel{position:fixed;top:10px;right:10px;z-index:2147483647;' +
          'background:#1e1e1e;color:#ccc;font:12px sans-serif;border-radius:6px;' +
          'padding:10px;min-width:260px;box-shadow:0 4px 16px rgba(0,0,0,0.5);pointer-events:auto}' +
          '#wix-sync-panel .dot{width:8px;height:8px;border-radius:50%;display:inline-block}' +
          '#wix-sync-panel .dot.c{background:#4caf50}#wix-sync-panel .dot.d{background:#f44336}' +
          '#wix-sync-panel .dot.s{background:#ff9800}' +
          '#wix-sync-panel select{width:100%;margin:4px 0;padding:4px;' +
          'background:#333;color:#ddd;border:1px solid #555;border-radius:3px;font-size:11px}' +
          '#wix-sync-panel button{width:100%;margin:6px 0;padding:6px;' +
          'background:#0e639c;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:12px}' +
          '#wix-sync-panel button:hover{background:#1177bb}' +
          '#wix-sync-panel button:disabled{background:#555;cursor:not-allowed}' +
          '#wix-sync-panel .btn-restore{background:#555}' +
          '#wix-sync-panel .btn-restore:hover{background:#666}' +
          '#wix-sync-panel .info{font-size:10px;color:#888;margin-top:4px}' +
          '#wix-sync-panel .pending{color:#2196f3;font-size:10px;margin-top:2px}' +
          '#wix-sync-panel .backup-info{font-size:10px;color:#888;margin-top:2px}' +
          '#wix-sync-panel hr{border:none;border-top:1px solid #444;margin:8px 0}' +
          '</style>' +
          '<div style="font-weight:bold;margin-bottom:8px">' +
          '<span class="dot d" id="wix-dot"></span> Wix Sync</div>' +
          '<div id="wix-status">Disconnected</div>' +
          '<select id="wix-local-file"><option value="">-- Select file --</option></select>' +
          '<div class="pending" id="wix-pending"></div>' +
          '<button id="wix-sync-btn" disabled>Sync Now</button>' +
          '<hr>' +
          '<div class="backup-info" id="wix-backup-info">Backups: --</div>' +
          '<button id="wix-restore-btn" class="btn-restore" disabled>Restore Last Backup</button>' +
          '<div class="info" id="wix-info"></div>';
        document.body.appendChild(el);
        document.getElementById('wix-sync-btn').addEventListener('click', onSyncClick);
        document.getElementById('wix-restore-btn').addEventListener('click', onRestoreClick);
      } catch (e) { console.error('[Wix Sync] Panel error:', e.message); }
    }

    function setStatus(state, text) {
      var dot = document.getElementById('wix-dot');
      var st = document.getElementById('wix-status');
      if (dot) dot.className = 'dot ' + state;
      if (st) st.textContent = text;
    }

    function setPending(hasPending) {
      var el = document.getElementById('wix-pending');
      if (el) el.textContent = hasPending ? 'Changes pending — click Sync' : '';
      updateSyncButton();
    }

    function updateFileSelect() {
      var sel = document.getElementById('wix-local-file');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- Select file --</option>';
      fileList.forEach(function (f) {
        var opt = document.createElement('option');
        opt.value = f; opt.textContent = f;
        if (mappedFile && mappedFile.localFile === f) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    function updateSyncButton() {
      var btn = document.getElementById('wix-sync-btn');
      if (btn) btn.disabled = !mappedFile || !pendingContent || syncing;
    }

    function updateRestoreButton() {
      var btn = document.getElementById('wix-restore-btn');
      if (btn) btn.disabled = !mappedFile || syncing;
    }

    function findEditorIframe() {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var f = iframes[i];
        if (f.src && f.src.indexOf('.ide.wix-code.com') !== -1 && f.src.indexOf('webWorker') === -1) {
          targetIframe = f;
          console.log('[Wix Sync] Found editor iframe');
          return;
        }
      }
      if (!targetIframe) setTimeout(findEditorIframe, 2000);
    }

    function sendToIframe(msg) {
      if (targetIframe && targetIframe.contentWindow) {
        targetIframe.contentWindow.postMessage({
          source: 'wix-sync',
          type: msg.type
        }, '*');
        return true;
      }
      return false;
    }

    function refreshBackupInfo() {
      if (!mappedFile || !ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'list_backups', file: mappedFile.localFile }));
    }

    function onRestoreClick() {
      if (!mappedFile || syncing) return;
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'list_backups', file: mappedFile.localFile }));
      window.__wixSyncRestorePending = true;
    }

    function onSyncClick() {
      if (!mappedFile || !pendingContent || syncing) return;

      if (!confirm(
        'Sync will overwrite the online IDE code with your local file.\n\n' +
        'A backup will be saved to: backups/' + mappedFile.localFile + '--<timestamp>.js\n\n' +
        'Continue?'
      )) {
        return;
      }

      syncing = true;
      updateSyncButton();
      updateRestoreButton();
      saveClipboard();

      setStatus('s', 'Backing up...');
      sendToIframe({ type: 'backup' });

      backupTimer = setTimeout(function () {
        abortSync('Backup timed out', 'backup_timeout');
      }, BACKUP_TIMEOUT);
    }

    function onIframeCopied() {
      if (!syncing) return;
      clearTimeout(backupTimer);
      backupTimer = null;

      try {
        navigator.clipboard.readText().then(function (onlineContent) {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'save_backup',
              file: mappedFile.localFile,
              content: onlineContent
            }));
            console.log('[Wix Sync] Backup saved, proceeding to sync');
          }
          startSync();
        }).catch(function (err) {
          abortSync(
            'Backup failed — online code NOT modified',
            'backup_read_denied:' + (err.message || 'unknown')
          );
        });
      } catch (e) {
        abortSync('Backup failed — online code NOT modified', 'backup_clipboard_error');
      }
    }

    function startSync() {
      setStatus('s', 'Syncing...');
      var content = pendingContent;

      try {
        navigator.clipboard.writeText(content).then(function () {
          sendToIframe({ type: 'paste' });
          pasteTimer = setTimeout(function () {
            abortSync('Paste timed out', 'paste_timeout');
          }, PASTE_TIMEOUT);
        }).catch(function (err) {
          abortSync('Clipboard write failed — sync aborted', 'clipboard_write_denied:' + err.message);
        });
      } catch (e) {
        abortSync('Clipboard error — sync aborted', 'clipboard_api_error');
      }
    }

    function onIframePasted() {
      if (!syncing) return;
      clearTimeout(pasteTimer);
      pasteTimer = null;
      restoreClipboard();

      pendingContent = null;
      syncing = false;
      setPending(false);
      updateRestoreButton();

      var now = new Date();
      var t = now.getHours() + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');

      setStatus('c', 'Synced — ' + mappedFile.localFile);

      var infoEl = document.getElementById('wix-info');
      if (infoEl) infoEl.textContent = 'Last sync: ' + t;

      refreshBackupInfo();
      console.log('[Wix Sync] Sync complete');
    }

    function connect() {
      if (ws) { try { ws.close(); } catch (e) {} }
      setStatus('d', 'Connecting...');
      ws = new WebSocket(WS_URL);
      ws.onopen = function () {
        setStatus('c', 'Connected');
        console.log('[Wix Sync] Connected');
        if (mappedFile) {
          ws.send(JSON.stringify({ type: 'request_file', file: mappedFile.localFile }));
          refreshBackupInfo();
        }
      };
      ws.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);
          handleMessage(msg);
        } catch (err) {
          console.error('[Wix Sync] Bad message:', err.message);
        }
      };
      ws.onclose = function () {
        setStatus('d', 'Disconnected');
        ws = null;
        setTimeout(connect, RECONNECT_DELAY);
      };
      ws.onerror = function () { setStatus('d', 'Error'); };
    }

    function handleMessage(msg) {
      switch (msg.type) {
        case 'file_list':
          fileList = msg.files;
          updateFileSelect();
          tryAutoMap();
          break;

        case 'file_changed':
          if (mappedFile && msg.file === mappedFile.localFile) {
            pendingContent = msg.content;
            setPending(true);
          }
          break;

        case 'backup_list':
          updateBackupDisplay(msg.backups);
          if (window.__wixSyncRestorePending && msg.backups && msg.backups.length > 0) {
            window.__wixSyncRestorePending = false;
            doRestoreBackup(msg.backups[0]);
          }
          break;

        case 'backup_content':
          if (msg.content !== null && msg.content !== undefined) {
            try {
              navigator.clipboard.writeText(msg.content).then(function () {
                sendToIframe({ type: 'paste' });
              }).catch(function (err) {
                setStatus('d', 'Restore: clipboard write failed');
                logError('restore_write_failed', err.message);
              });
            } catch (e) {
              setStatus('d', 'Restore: clipboard error');
              logError('restore_clipboard_error', e.message);
            }
          } else {
            setStatus('d', 'Restore: backup not found');
            logError('restore_not_found', msg.backupName);
          }
          break;
      }
    }

    function updateBackupDisplay(backups) {
      var el = document.getElementById('wix-backup-info');
      var btn = document.getElementById('wix-restore-btn');
      if (!backups || backups.length === 0) {
        if (el) el.textContent = 'Backups: none';
        if (btn) btn.disabled = true;
      } else {
        if (el) el.textContent = 'Backups: ' + backups.length + ' (' + backups[0] + ')';
        if (btn) btn.disabled = syncing ? true : false;
      }
    }

    function doRestoreBackup(backupName) {
      if (!ws || ws.readyState !== 1 || !mappedFile) return;
      if (!confirm(
        'Restore online IDE code from backup?\n\n' +
        'Backup: ' + backupName + '\n\n' +
        'This will OVERWRITE the current online code with the backup version.'
      )) {
        return;
      }
      setStatus('s', 'Restoring ' + backupName + '...');
      ws.send(JSON.stringify({ type: 'read_backup', backupName: backupName }));
    }

    function tryAutoMap() {
      sendToIframe({ type: 'request_file' });
    }

    function saveMapping() {
      try { localStorage.setItem('wix-sync-mapping', JSON.stringify(mappedFile)); } catch (e) {}
    }

    function loadMapping() {
      try {
        var raw = localStorage.getItem('wix-sync-mapping');
        if (raw) { var m = JSON.parse(raw); if (m) mappedFile = m; }
      } catch (e) {}
    }

    function requestCurrentContent() {
      if (ws && ws.readyState === 1 && mappedFile) {
        ws.send(JSON.stringify({ type: 'request_file', file: mappedFile.localFile }));
      }
    }

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg || msg.source !== 'wix-sync') return;

      switch (msg.type) {
        case 'editor_ready':
          console.log('[Wix Sync] Iframe reports editor ready');
          tryAutoMap();
          break;

        case 'open_file':
          if (msg.filename) {
            tryMapFilename(msg.filename);
          }
          break;

        case 'copied':
          if (syncing) onIframeCopied();
          break;

        case 'pasted':
          onIframePasted();
          break;

        case 'command_error':
          abortSync('Editor command failed: ' + (msg.error || 'unknown'), 'command_error:' + (msg.error || 'unknown'));
          break;
      }
    });

    function tryMapFilename(filename) {
      if (fileList.length === 0) return;
      for (var j = 0; j < fileList.length; j++) {
        if (fileList[j] === filename) {
          setMapping(fileList[j]);
          return;
        }
      }
      for (var k = 0; k < fileList.length; k++) {
        if (filename.indexOf(fileList[k]) !== -1 || fileList[k].indexOf(filename) !== -1) {
          setMapping(fileList[k]);
          return;
        }
      }
    }

    function setMapping(localName) {
      mappedFile = { localFile: localName };
      updateFileSelect();
      updateSyncButton();
      updateRestoreButton();
      setStatus('c', 'Mapped: ' + localName);
      saveMapping();
      requestCurrentContent();
      refreshBackupInfo();
    }

    function init() {
      console.log('[Wix Sync] Top window init, URL:', location.href);
      if (!isEditorFrame()) { console.log('[Wix Sync] Skip non-editor frame'); return; }

      console.log('[Wix Sync] Editor frame, starting...');
      createPanel();
      loadMapping();

      if (mappedFile) {
        updateFileSelect();
        updateSyncButton();
      }

      var fileSelect = document.getElementById('wix-local-file');
      if (fileSelect) {
        fileSelect.addEventListener('change', function () {
          var selectedFile = this.value;
          pendingContent = null;
          setPending(false);
          if (!selectedFile) {
            mappedFile = null; saveMapping();
            updateSyncButton();
            updateRestoreButton();
            setStatus('c', 'Connected (no mapping)');
            return;
          }
          setMapping(selectedFile);
        });
      }

      findEditorIframe();
      connect();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // =========================================================================
  //  IFRAME (VS Code editor) — Promise-chained clipboard commands
  // =========================================================================
  else if (!isWebWorker) {

    var executeCommand = null;
    var bootAttempts = 0;
    var MAX_BOOT = 30;

    function notifyParent(msg) {
      window.parent.postMessage({
        source: 'wix-sync',
        type: msg.type,
        filename: msg.filename,
        error: msg.error
      }, '*');
    }

    function bootstrap() {
      bootAttempts++;
      try {
        var wb = require('vs/workbench/workbench.web.main');
        if (wb && wb.commands && typeof wb.commands.executeCommand === 'function') {
          executeCommand = wb.commands.executeCommand;
          console.log('[Wix Sync:iframe] Commands ready');
          reportOpenFile();
          return;
        }
      } catch (e) {}

      if (bootAttempts < MAX_BOOT) {
        setTimeout(bootstrap, 1000);
      } else {
        console.log('[Wix Sync:iframe] Bootstrap exhausted');
        notifyParent({ type: 'editor_lost' });
      }
    }

    function getOpenFilename() {
      var el = document.querySelector('.monaco-editor[data-uri]');
      if (!el) return null;
      var uri = el.getAttribute('data-uri');
      if (!uri) return null;
      try {
        var afterUserCode = uri.split('/user-code/')[1];
        if (afterUserCode) {
          var encoded = afterUserCode.split('/').pop();
          if (encoded) return decodeURIComponent(encoded);
        }
      } catch (e) {}
      try {
        var parts = uri.split('/');
        var last = parts[parts.length - 1];
        if (last) return decodeURIComponent(last);
      } catch (e2) {}
      return null;
    }

    function reportOpenFile() {
      var filename = getOpenFilename();
      if (filename) {
        console.log('[Wix Sync:iframe] Open file:', filename);
        notifyParent({ type: 'editor_ready', filename: filename });
        notifyParent({ type: 'open_file', filename: filename });
      } else {
        setTimeout(reportOpenFile, 1500);
      }
    }

    function copyFromEditor() {
      executeCommand('editor.action.selectAll')
        .then(function () {
          return executeCommand('editor.action.clipboardCopyAction');
        })
        .then(function () {
          window.parent.postMessage({ source: 'wix-sync', type: 'copied' }, '*');
        })
        .catch(function (err) {
          console.error('[Wix Sync:iframe] Copy failed:', err.message);
          notifyParent({ type: 'command_error', error: 'copy:' + err.message });
        });
    }

    function pasteToEditor() {
      executeCommand('editor.action.selectAll')
        .then(function () {
          return executeCommand('editor.action.clipboardPasteAction');
        })
        .then(function () {
          window.parent.postMessage({ source: 'wix-sync', type: 'pasted' }, '*');
        })
        .catch(function (err) {
          console.error('[Wix Sync:iframe] Paste failed:', err.message);
          notifyParent({ type: 'command_error', error: 'paste:' + err.message });
        });
    }

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg || msg.source !== 'wix-sync') return;
      if (!executeCommand) { console.log('[Wix Sync:iframe] Not ready'); return; }

      switch (msg.type) {
        case 'backup':
          copyFromEditor();
          break;
        case 'paste':
          pasteToEditor();
          break;
        case 'request_file':
          var fn = getOpenFilename();
          if (fn) notifyParent({ type: 'open_file', filename: fn });
          break;
      }
    });

    function initIframe() {
      console.log('[Wix Sync:iframe] Init, URL:', location.href);
      if (!document.body) { setTimeout(initIframe, 300); return; }
      bootstrap();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initIframe);
    } else {
      initIframe();
    }
  }

  else {
    console.log('[Wix Sync] Skip web worker frame');
  }

})();
