/* Backup & Restore system for the complete algo suite.
 *
 * Captures the ENTIRE algo system state — every tab, every engine's settings
 * (Paper Trade, Smart NTrader, Auto Experiment, AI Smart, AIPT, HFT Pool/Runner,
 * Index Trend, Strategy Container), all saved templates, all saved strategies,
 * P&L records, monitor lists, strategy assignments — because every one of those
 * persists in the browser's localStorage.
 *
 * Features:
 *   - Export Now: write a full timestamped snapshot to the configured path
 *     (Windows PC path supported) via the Flask server.
 *   - Download Backup: same full snapshot as a .json download, works even when
 *     no path is configured.
 *   - Import / Restore: apply a backup file or a server-stored snapshot back
 *     into localStorage and reload. A safety copy is taken before restoring.
 *   - Auto incremental backup: enable/disable toggle + daily/weekly schedule
 *     (clock time). A background timer fires when the scheduled time is reached
 *     and catches up immediately after the page loads if a schedule was missed
 *     while the app was closed. Old auto snapshots are auto-pruned (keep N).
 */
(function () {
  var BACKUP_API = "/api/backup";
  var POLL_MS = 60000;   // auto-backup scheduler cadence
  var _cfg = null;
  var _busy = false;
  var _timer = null;
  var _dirHandle = null; // File System Access API directory handle for direct-to-PC saves
  var _DIR_DB = "algodhan-backup-handles";

  /* ---- IndexedDB persistence for the chosen PC folder ----------------------- */

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      var req = window.indexedDB.open(_DIR_DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles");
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function persistDirHandle(handle) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction("handles", "readwrite");
        tx.objectStore("handles").put(handle, "backupDir");
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function loadDirHandle() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction("handles", "readonly");
        var get = tx.objectStore("handles").get("backupDir");
        get.onsuccess = function () { resolve(get.result || null); };
        get.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function adoptDirHandle(handle) {
    if (!handle) return;
    var per = handle.queryPermission ? handle.queryPermission({ mode: "readwrite" }) : Promise.resolve("granted");
    per.then(function (state) {
      if (state === "granted") {
        _dirHandle = handle;
        var nameEl = $id("backupDirName");
        if (nameEl) nameEl.textContent = "Saving to: " + (handle.name || "selected folder") + " ✓";
        var autoEl = $id("backupAutoDirName");
        if (autoEl) autoEl.textContent = "Saving to: " + (handle.name || "selected folder") + " ✓";
      }
    }).catch(function () {});
  }

  function $id(id) { return document.getElementById(id); }
  function fmtTime(iso) {
    if (iso == null || iso === "") return "—";
    try {
      var ms = typeof iso === "number" ? iso : Date.parse(iso);
      if (isNaN(ms)) return iso;
      if (window.IST12 && IST12.fmtMsDT) return IST12.fmtMsDT(ms);
      return new Date(ms).toLocaleString();
    } catch (e) { return iso; }
  }
  function sizeFmt(b) {
    if (!b && b !== 0) return "—";
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(2) + " MB";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(BACKUP_API + path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, message: "Bad server response" }; });
    });
  }

  /* ---- snapshot build/apply ------------------------------------------------- */

  function gatherLS() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        out[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    return out;
  }

  function buildSnapshot(kind) {
    var ls = gatherLS();
    return {
      format: "algodhan_backup",
      version: 1,
      created_at: new Date().toISOString(),
      kind: kind || "manual",
      app: "Smart NTrader + Algo Suite",
      count: { keys: Object.keys(ls).length },
      data: { localStorage: ls },
      config: _cfg || null,
    };
  }

  function applyData(data) {
    var ls = data && data.data && data.data.localStorage;
    if (!ls || typeof ls !== "object") throw new Error("Invalid backup: missing data.localStorage");
    var n = 0;
    Object.keys(ls).forEach(function (k) { localStorage.setItem(k, ls[k]); n++; });
    return n;
  }

  /* ---- actions -------------------------------------------------------------- */

  function saveConfig(partial) {
    return api("/config", { method: "POST", body: partial }).then(function (r) {
      if (r.ok) _cfg = r.config;
      return r;
    });
  }

  function backupNow(kind) {
    var snapshot = buildSnapshot(kind || "manual");
    return api("/snapshot", { method: "POST", body: { data: snapshot.data, kind: snapshot.kind } })
      .then(function (r) {
        if (r.ok && r.config) _cfg = r.config;
        return r;
      });
  }

  function downloadBackup() {
    var snapshot = buildSnapshot("manual");
    var blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var ts = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15);
    a.href = url;
    a.download = "algodhan_backup_" + ts + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    return snapshot;
  }

  /* ---- direct save to a PC folder (File System Access API) ------------------ */

  function chooseDir() {
    var nameEl = $id("backupDirName");
    if (!window.showDirectoryPicker) {
      if (nameEl) nameEl.textContent = "Not supported in this browser — exports will download instead.";
      statusLine("Folder picker not supported here — the export will download as a file.", true);
      return;
    }
    window.showDirectoryPicker({ mode: "readwrite", id: "algodhan-backup" })
      .then(function (handle) {
        _dirHandle = handle;
        persistDirHandle(handle);
        if (nameEl) nameEl.textContent = "Saving to: " + (handle.name || "selected folder") + " ✓";
        var autoEl = $id("backupAutoDirName");
        if (autoEl) autoEl.textContent = "Saving to: " + (handle.name || "selected folder") + " ✓";
        statusLine("Folder chosen: " + (handle.name || "PC folder") + " — Export Now and Auto Backup will save straight into it.", false);
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          statusLine("Folder selection cancelled.", false);
          return;
        }
        if (nameEl) nameEl.textContent = "Folder access blocked — exports will download instead.";
        statusLine("Could not open folder: " + (err && err.message ? err.message : "permission denied"), true);
      });
  }

  function saveToDir(snapshot) {
    if (!_dirHandle) return Promise.reject(new Error("No folder chosen"));
    var ts = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15);
    var name = "algodhan_backup_" + ts + ".json";
    return _dirHandle.getFileHandle(name, { create: true })
      .then(function (fh) {
        return fh.createWritable().then(function (w) {
          return w.write(JSON.stringify(snapshot, null, 2)).then(function () { return w.close(); });
        });
      })
      .then(function () { return name; });
  }

  /* Keep only the newest `keep` auto backup files in the chosen PC folder,
   * mirroring the server-side pruning, so the folder never grows unbounded. */
  function pruneDir(keep) {
    if (!_dirHandle || !_dirHandle.values) return Promise.resolve();
    keep = keep || 30;
    var files = [];
    var walker = _dirHandle.values();
    var next = function () {
      return walker.next().then(function (step) {
        if (step.done) {
          files.sort(function (a, b) { return b.mtime - a.mtime; });
          var extra = files.slice(keep);
          var jobs = extra.map(function (f) {
            return f.handle.remove().catch(function () {});
          });
          return Promise.all(jobs).then(function () {});
        }
        var entry = step.value;
        if (entry && entry.kind === "file" && /^backup_auto_.*\.json$/.test(entry.name)) {
          return entry.getFile().then(function (f) {
            files.push({ name: entry.name, handle: entry, mtime: f.lastModified });
            return next();
          }).catch(function () { return next(); });
        }
        return next();
      });
    };
    return next().catch(function () {});
  }

  /* Auto backup: write to the chosen PC folder when available, otherwise fall
   * back to the server path. Scheduling state is always recorded server-side. */
  function autoBackup() {
    var snapshot = buildSnapshot("auto");
    if (_dirHandle && window.showDirectoryPicker) {
      return saveToDir(snapshot).then(function (name) {
        var keep = parseInt(($id("backupKeep") && $id("backupKeep").value) || "30", 10) || 30;
        return pruneDir(keep).then(function () { return name; });
      }).then(function (name) {
        // Record schedule/lastResult server-side without writing a server file.
        return api("/snapshot", { method: "POST", body: { data: snapshot.data, kind: "auto", pc_only: true } })
          .then(function (r) {
            if (r.ok && r.config) _cfg = r.config;
            return { ok: true, file: name, dir: true, r: r };
          })
          .catch(function () { return { ok: true, file: name, dir: true, r: null }; });
      }).catch(function (err) {
        // PC save failed (permission etc.) -> fall back to server path.
        return backupNow("auto").then(function (r) {
          return { ok: r.ok, file: r.file, dir: false, r: r, message: r.message };
        });
      });
    }
    return backupNow("auto").then(function (r) {
      return { ok: r.ok, file: r.file, dir: false, r: r, message: r.message };
    });
  }

  function readServerFile(name) {
    return api("/read?file=" + encodeURIComponent(name));
  }

  function importPayload(data) {
    // Optionally keep a server copy of the import.
    return api("/import", { method: "POST", body: { data: data.data } }).then(function () { return data; });
  }

  function doRestore(data, sourceLabel) {
    // Safety copy of the CURRENT state before it is overwritten, so a bad
    // restore can always be rolled back. Best-effort: works when a path is set.
    backupNow("pre_restore").then(function () {
      var n;
      try { n = applyData(data); }
      catch (e) { statusLine("Restore failed: " + e.message, true); return; }
      statusLine("Restored " + n + " settings from " + (sourceLabel || "backup") + " — reloading…", false);
      setTimeout(function () { location.reload(); }, 900);
    });
  }

  function restoreServerFile(name) {
    return readServerFile(name).then(function (r) {
      if (!r.ok || !r.backup) { statusLine("Restore failed: " + (r.message || "cannot read backup"), true); return; }
      return doRestore(r.backup, name);
    });
  }

  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); }
      catch (e) { statusLine("Import failed: not valid JSON", true); return; }
      if (!data || data.format !== "algodhan_backup" || !data.data) {
        statusLine("Import failed: not an algodhan backup file", true);
        return;
      }
      importPayload(data).then(function () {
        backupNow("pre_restore").then(function () {
          var n;
          try { n = applyData(data); }
          catch (e) { statusLine("Import failed: " + e.message, true); return; }
          statusLine("Imported " + n + " settings — reloading…", false);
          setTimeout(function () { location.reload(); }, 900);
        });
      });
    };
    reader.readAsText(file);
  }

  /* ---- auto-backup scheduler ------------------------------------------------- */

  function tick() {
    if (!_cfg) return;
    if (_busy) return;
    if (!_cfg.enabled) return;
    var next = _cfg.nextDue ? Date.parse(_cfg.nextDue) : 0;
    if (isNaN(next)) next = 0;
    if (Date.now() >= next) {
      _busy = true;
      autoBackup().then(function (res) {
        _busy = false;
        if (!res.ok) { statusLine("Auto backup failed: " + (res.message || "unknown"), true); }
        else if (res.dir) { statusLine("Auto backup saved to PC folder: " + res.file, false); }
        else { statusLine("Auto backup saved: " + res.file, false); }
        refresh();
      });
    }
  }

  /* ---- UI -------------------------------------------------------------------- */

  function statusLine(msg, isErr) {
    var el = $id("backupStatus");
    if (!el) return;
    el.style.color = isErr ? "#ff4d6a" : "#00d4aa";
    el.textContent = msg;
  }

  function renderHistory(list) {
    var box = $id("backupHistory");
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = '<div style="color:#666;font-size:11px;padding:8px">No server backups yet. Export now to save a backup directly to your PC.</div>';
      return;
    }
    var html = '<table class="account-table" style="width:100%;font-size:11px"><thead><tr><th>File</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody>';
    list.slice(0, 25).forEach(function (f) {
      var kind = /^backup_auto_/.test(f.name) ? '<span style="color:#66ccff;font-size:9px">AUTO</span>' :
                 /^backup_pre_restore_/.test(f.name) ? '<span style="color:#b39ddb;font-size:9px">PRE</span>' : '';
      html += '<tr style="border-bottom:1px solid #1e1e40">' +
        '<td>' + esc(f.name) + ' ' + kind + '</td>' +
        '<td>' + sizeFmt(f.size) + '</td>' +
        '<td>' + fmtTime(f.mtime) + '</td>' +
        '<td><button class="btn-action" data-restore="' + esc(f.name) + '" style="padding:2px 8px;font-size:10px;width:auto;margin:0">Restore</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
    box.querySelectorAll("[data-restore]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var name = btn.getAttribute("data-restore");
        if (confirm("Restore '" + name + "'? Current data will be replaced (a safety copy is saved first). Page will reload.")) {
          restoreServerFile(name);
        }
      });
    });
  }

  function setValIfBlurred(id, val) {
    var el = $id(id);
    if (!el) return;
    if (document.activeElement && document.activeElement === el) return; // don't clobber typing
    el.value = val;
  }

  /* Fade out every timeframe card except the selected one, and disable the
   * inputs inside the inactive cards so the schedule stays unambiguous. */
  function applyTFState() {
    var cards = document.querySelectorAll(".backup-tf-card");
    var sel = document.querySelector('input[name="backupTF"]:checked');
    var selVal = sel ? sel.value : "minute";
    cards.forEach(function (card) {
      var radio = card.querySelector('input[name="backupTF"]');
      var active = radio && radio.value === selVal;
      card.style.opacity = active ? "1" : "0.35";
      card.style.borderColor = active ? "#00d4aa" : "#2d2d50";
      card.querySelectorAll("input,select").forEach(function (el) {
        if (el.type !== "radio") el.disabled = !active;
      });
    });
  }

  function render() {
    return api("/list").then(function (r) {
      if (!r.ok) { statusLine(r.message || "Cannot reach backup server", true); return; }
      _cfg = r.config;
      var c = r.config || {};
      $id("backupEnabled").checked = !!c.enabled;
      var sch = c.schedule || {};
      var schedType = ["minute", "hour", "daily", "weekly"].indexOf(sch.type) >= 0 ? sch.type : "minute";
      var radio = document.querySelector('input[name="backupTF"][value="' + schedType + '"]');
      if (radio) radio.checked = true;
      setValIfBlurred("backupMinInterval", sch.interval != null ? String(sch.interval) : "5");
      setValIfBlurred("backupHourInterval", sch.interval != null ? String(sch.interval) : "6");
      setValIfBlurred("backupTime", sch.time || "18:00");
      setValIfBlurred("backupWeekTime", sch.time || "18:00");
      setValIfBlurred("backupWeekday", String(sch.weekday || 0));
      setValIfBlurred("backupKeep", String(sch.keep || 30));
      applyTFState();
      var next = c.nextDue;
      if (c.enabled && next) {
        $id("backupNextDue").textContent = "Next auto backup: " + fmtTime(next);
      } else if (c.enabled) {
        $id("backupNextDue").textContent = "Next auto backup: as soon as a backup is due (immediate catch-up)";
      } else {
        $id("backupNextDue").textContent = "Auto backup disabled";
      }
      var lr = c.lastResult || {};
      $id("backupLastInfo").textContent = (lr.message || "ready") + (lr.at ? " · " + fmtTime(lr.at) : "") + (lr.file ? " · " + lr.file : "");
      var autoDot = $id("backupAutoDot");
      if (autoDot) { autoDot.style.background = c.enabled ? "#00d4aa" : "#666"; }
      statusLine("Backup server ready — " + (c.enabled ? "auto backup ON" : "auto backup OFF"), false);
      renderHistory(r.list);
    }).catch(function () { statusLine("Cannot reach backup server", true); });
  }

  function refresh() { return render(); }

  function wire() {
    $id("backupChooseDirBtn").addEventListener("click", function () {
      chooseDir();
    });

    $id("backupExportBtn").addEventListener("click", function () {
      if (_busy) return;
      var snapshot = buildSnapshot("manual");
      if (_dirHandle && window.showDirectoryPicker) {
        _busy = true;
        saveToDir(snapshot).then(function (name) {
          _busy = false;
          statusLine("Backup saved directly to PC folder: " + name, false);
          $id("backupLastInfo").textContent = "saved to PC · " + fmtTime(snapshot.created_at);
        }).catch(function (err) {
          _busy = false;
          if (err && err.message === "No folder chosen") {
            downloadBackup();
            statusLine("Downloaded backup (" + snapshot.count.keys + " settings keys)", false);
          } else {
            statusLine("Direct save failed (" + (err && err.message || "error") + ") — downloaded instead.", true);
            downloadBackup();
          }
        });
      } else {
        downloadBackup();
        statusLine("Downloaded backup (" + snapshot.count.keys + " settings keys)", false);
      }
    });

    $id("backupDownloadBtn").addEventListener("click", function () {
      var snap = downloadBackup();
      statusLine("Downloaded backup (" + snap.count.keys + " settings keys)", false);
    });

    $id("backupImportBtn").addEventListener("click", function () {
      $id("backupFileInput").click();
    });
    $id("backupFileInput").addEventListener("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (f) handleImportFile(f);
      ev.target.value = "";
    });

    $id("backupAutoSavePcBtn").addEventListener("click", function () {
      chooseDir();
    });

    document.querySelectorAll('input[name="backupTF"]').forEach(function (radio) {
      radio.addEventListener("change", applyTFState);
    });

    $id("backupSaveCfg").addEventListener("click", function () {
      var radio = document.querySelector('input[name="backupTF"]:checked');
      var schedType = radio ? radio.value : "minute";
      var interval = null;
      var time = "18:00";
      var weekday = 0;
      if (schedType === "minute") {
        interval = parseInt($id("backupMinInterval").value, 10) || 5;
      } else if (schedType === "hour") {
        interval = parseInt($id("backupHourInterval").value, 10) || 6;
      } else if (schedType === "weekly") {
        time = $id("backupWeekTime").value || "18:00";
        weekday = parseInt($id("backupWeekday").value, 10) || 0;
      } else {
        time = $id("backupTime").value || "18:00";
      }
      saveConfig({
        enabled: $id("backupEnabled").checked,
        schedule: {
          type: schedType,
          interval: interval,
          time: time,
          weekday: weekday,
          keep: parseInt($id("backupKeep").value, 10) || 30,
        },
      }).then(function (r) {
        if (!r.ok) { statusLine(r.message || "Save failed", true); return; }
        statusLine(r.config.enabled ? "Auto backup enabled — schedule saved" : "Auto backup disabled — settings saved", false);
        render();
        if (r.config.enabled && !_busy) {
          _busy = true;
          autoBackup().then(function (res) {
            _busy = false;
            if (!res.ok) statusLine("Auto backup enabled but first save failed: " + (res.message || "unknown"), true);
            else if (res.dir) statusLine("Auto backup enabled — first backup saved to PC folder: " + res.file, false);
            else statusLine("Auto backup enabled — first backup saved: " + res.file, false);
            refresh();
          });
        }
      });
    });
  }

  function init() {
    if (!document.getElementById("backupPanel")) return; // panel not mounted
    wire();
    render();
    loadDirHandle().then(adoptDirHandle); // restore the chosen PC folder (if permission granted)
    if (_timer) clearInterval(_timer);
    _timer = setInterval(tick, POLL_MS);
    setTimeout(tick, 2500); // catch-up check right after load
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 600); });
  } else {
    setTimeout(init, 600);
  }

  window.BackupSys = {
    init: init,
    render: render,
    refresh: refresh,
    getConfig: function () { return _cfg; },
    backupNow: backupNow,
    autoBackup: autoBackup,
    download: downloadBackup,
    importPayload: importPayload,
    restoreServerFile: restoreServerFile,
    handleImportFile: handleImportFile,
    applyData: applyData,
    tick: tick,
    chooseDir: chooseDir,
    saveToDir: saveToDir,
    pruneDir: pruneDir,
  };
})();
