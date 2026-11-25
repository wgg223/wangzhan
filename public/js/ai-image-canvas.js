/**
 * AI 生图节点画布（独立、无外部依赖）
 * 主脚本通过 window.aiImageGenerate / aiImageOpenLightbox / aiImageSetMode 接入。
 */
(function () {
  'use strict';

  // 画布引擎配置：/ai-canvas 独立通道通过 window.AI_CANVAS_CONFIG 注入；
  // 不注入时保持原有 /ai-image 内嵌画布的行为。
  var CFG = (typeof window !== 'undefined' && window.AI_CANVAS_CONFIG) || {};
  var DATA_ELEMENT_ID = CFG.dataElementId || 'ai-image-data';
  var STANDALONE = Boolean(CFG.standalone);
  var CUSTOM_SIZE = CFG.customSize !== false;
  var SERVER = CFG.server || null; // { apiBase, projectId, canEdit, csrfToken }

  var STORAGE_KEY = CFG.storageKey || 'ai-image-canvas-v1';
  var THEME_KEY = 'ai-image-canvas-theme-v1';
  var DB_NAME = 'ai-image-canvas-assets';
  var DB_STORE = 'uploads';
  var DB_VERSION = 1;
  var NODE_WIDTH = { upload: 252, text: 296, image: 288 };
  var NODE_HEIGHT = { upload: 220, text: 220, image: 372 };
  var PORT_Y = 37;
  var MAX_FILE_SIZE = 100 * 1024 * 1024;
  var MAX_NODES = 200;
  var SNAP_KEY = 'ai-image-canvas-snap-v1';
  var MINIMAP_KEY = 'ai-image-canvas-minimap-v1';
  var SNAP_SIZE = 8;
  var SNAP_THRESHOLD = 6;
  var MINIMAP_WIDTH = 184;
  var MINIMAP_HEIGHT = 120;
  var EXPORT_PADDING = 48;
  var initializedRoot = null;
  var readyHandler = null;
  var dbPromise = null;

  function make(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function on(el, type, handler, options) {
    if (el) el.addEventListener(type, handler, options || false);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function safeText(value, fallback, max) {
    var text = typeof value === 'string' ? value : fallback;
    return text.slice(0, max || 12000);
  }

  // 只允许浏览器可安全显示的图片地址；拒绝 javascript:、未知协议和属性式输入。
  function safeImageUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 8000000) return '';
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value)) return value;
    if (/^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)) return value;
    return '';
  }

  function readDataElement() {
    var el = document.getElementById(DATA_ELEMENT_ID) || document.getElementById('ai-image-data');
    if (!el) return {};
    try {
      var parsed = JSON.parse(el.textContent || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      var request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('本地图片存储不可用')); };
      request.onblocked = function () { reject(new Error('本地图片存储被阻塞')); };
    });
    return dbPromise;
  }

  function putBlob(id, blob) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put({ id: id, blob: blob, name: blob.name || '', createdAt: Date.now() });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error('图片保存失败')); };
        tx.onabort = function () { reject(tx.error || new Error('图片保存被取消')); };
      });
    });
  }

  function getBlob(id) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        var request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error || new Error('图片读取失败')); };
      });
    });
  }

  // 导入项目时给 IndexedDB 写入加超时：隐私模式或存储被禁用时不应让导入流程卡死。
  function putBlobSafe(id, blob, timeoutMs) {
    return Promise.race([
      putBlob(id, blob).then(function () { return true; }).catch(function () { return false; }),
      new Promise(function (resolve) { setTimeout(function () { resolve(false); }, timeoutMs || 4000); })
    ]);
  }

  function loadTheme() {
    try {
      var value = localStorage.getItem(THEME_KEY);
      if (value === 'light' || value === 'dark') return value;
    } catch (err) {
      // 隐私模式可能禁用 localStorage，主题仍在本次会话中生效。
    }
    return 'dark';
  }

  function saveTheme(value) {
    try { localStorage.setItem(THEME_KEY, value); } catch (err) {
      // 存储不可用时保留当前主题。
    }
  }

  function loadFlag(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      if (value === '1') return true;
      if (value === '0') return false;
    } catch (err) {
      // 隐私模式下沿用默认值。
    }
    return fallback;
  }

  function saveFlag(key, value) {
    try { localStorage.setItem(key, value ? '1' : '0'); } catch (err) {
      // 存储不可用时仅在本次会话生效。
    }
  }

  var CSS = `
.aic{--aic-bg:#111216;--aic-panel:#1a1c22;--aic-panel-2:#22252d;--aic-border:#343842;--aic-text:#f1f2f5;--aic-muted:#969caa;--aic-accent:#a992ff;--aic-accent-2:#7963dc;--aic-dot:#343741;--aic-input:#14161b;--aic-danger:#ef6a72;--aic-success:#5fc99b;position:relative;width:100%;height:100%;min-height:560px;overflow:hidden;background:var(--aic-bg);color:var(--aic-text);font-family:inherit;font-size:13px;line-height:1.5;isolation:isolate;contain:layout paint}
.aic *{box-sizing:border-box}.aic button,.aic input,.aic textarea,.aic select{font:inherit}.aic button{color:inherit}.aic button:focus-visible,.aic textarea:focus-visible,.aic input:focus-visible,.aic select:focus-visible{outline:2px solid var(--aic-accent);outline-offset:2px}.aic button:disabled{opacity:.45;cursor:not-allowed}
.aic.light{--aic-bg:#f4f5f8;--aic-panel:#fff;--aic-panel-2:#f0f1f6;--aic-border:#d8dbe5;--aic-text:#242632;--aic-muted:#747b8e;--aic-accent:#7457d9;--aic-accent-2:#6248c3;--aic-dot:#d0d3df;--aic-input:#f7f8fb;--aic-danger:#cf3f4b;--aic-success:#238760}
.aic-top{position:absolute;z-index:20;inset:0 0 auto;height:62px;display:flex;align-items:center;gap:14px;padding:10px 18px;border-bottom:1px solid var(--aic-border);background:var(--aic-panel)}
.aic-brand{display:flex;align-items:center;gap:10px;min-width:210px}.aic-logo{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,var(--aic-accent),#5e77dd);color:#fff;font-weight:700;font-size:16px}.aic-project{font-weight:650;font-size:14px;letter-spacing:.02em}.aic-date{margin-top:1px;color:var(--aic-muted);font-size:11px}.aic-top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}.aic-quota{color:var(--aic-muted);font-size:12px;margin-right:6px;white-space:nowrap}
.aic-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 11px;border:1px solid var(--aic-border);border-radius:8px;background:var(--aic-panel-2);cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}.aic-btn:hover{background:var(--aic-border);border-color:var(--aic-muted)}.aic-btn.active{color:#fff;background:var(--aic-accent-2);border-color:var(--aic-accent-2)}.aic-btn.primary{color:#fff;background:var(--aic-accent-2);border-color:var(--aic-accent-2);font-weight:650}.aic-btn.primary:hover{filter:brightness(1.1)}.aic-btn.danger{color:var(--aic-danger)}.aic-icon-btn{width:34px;height:34px;padding:0}.aic-btn svg,.aic-icon-btn svg{width:16px;height:16px;display:block;flex:none}
.aic-viewport{position:absolute;inset:62px 0 0;overflow:hidden;touch-action:none;cursor:grab;background-color:var(--aic-bg);background-image:radial-gradient(circle,var(--aic-dot) 1px,transparent 1.2px);background-size:24px 24px;background-position:var(--aic-dot-x,0px) var(--aic-dot-y,0px)}.aic-viewport.panning{cursor:grabbing}.aic-viewport.linking{cursor:crosshair}
.aic-world{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;will-change:transform}.aic-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;width:1px;height:1px}.aic-edge{fill:none;stroke:var(--aic-accent);stroke-width:2;vector-effect:non-scaling-stroke;opacity:.8}.aic-edge.selected{stroke-width:3;opacity:1}.aic-edge-hit{fill:none;stroke:transparent;stroke-width:14;vector-effect:non-scaling-stroke;pointer-events:stroke;cursor:pointer}.aic-temp-edge{fill:none;stroke:var(--aic-accent);stroke-width:2;stroke-dasharray:6 5;vector-effect:non-scaling-stroke}
.aic-node{position:absolute;width:296px;border:1px solid var(--aic-border);border-radius:13px;background:var(--aic-panel);box-shadow:0 10px 34px rgba(0,0,0,0.2);cursor:grab;user-select:none;touch-action:none;transition:box-shadow .15s,border-color .15s}.aic-node.type-upload{width:252px}.aic-node.type-image{width:288px}.aic-node.selected{border-color:var(--aic-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--aic-accent) 28%,transparent),0 12px 36px rgba(0,0,0,0.28)}.aic-node.dragging{cursor:grabbing;box-shadow:0 18px 44px rgba(0,0,0,.35)}.aic-node.generating{border-color:var(--aic-accent)}
.aic-node-head{height:44px;display:flex;align-items:center;gap:9px;padding:0 12px;border-bottom:1px solid var(--aic-border)}.aic-node-mark{width:25px;height:25px;border-radius:7px;display:grid;place-items:center;background:color-mix(in srgb,var(--aic-accent) 17%,transparent);color:var(--aic-accent);font-size:11px;font-weight:700}.aic-type-upload .aic-node-mark{background:rgba(74,169,218,.15);color:#55b5e4}.aic-type-image .aic-node-mark{background:rgba(91,201,155,.14);color:var(--aic-success)}.aic-node-title{font-weight:600;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aic-node-meta{margin-left:auto;color:var(--aic-muted);font-size:10px;white-space:nowrap}.aic-node-menu{width:25px;height:25px;padding:0;border:0;background:transparent;color:var(--aic-muted);cursor:pointer;font-size:18px;line-height:1}
.aic-port{position:absolute;z-index:4;top:28px;width:13px;height:13px;border:2px solid var(--aic-panel);border-radius:50%;background:var(--aic-muted);cursor:crosshair;touch-action:none;box-shadow:0 0 0 1px var(--aic-border)}.aic-port:hover,.aic-port.armed,.aic-port.link-target{background:var(--aic-accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--aic-accent) 22%,transparent)}.aic-port.input{left:-7px}.aic-port.output{right:-7px}.aic-port:disabled{opacity:.3;cursor:not-allowed}
.aic-node-body{padding:11px}.aic-thumb{position:relative;height:128px;display:grid;place-items:center;overflow:hidden;border-radius:8px;background:var(--aic-input);border:1px dashed var(--aic-border);cursor:pointer}.aic-thumb img{width:100%;height:100%;object-fit:cover;display:block}.aic-empty-thumb{color:var(--aic-muted);font-size:11px}.aic-node-caption{display:flex;gap:8px;align-items:center;margin-top:9px;min-width:0}.aic-node-caption span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--aic-muted);font-size:11px}.aic-node-caption span:first-child{color:var(--aic-text);flex:1}.aic-mini-btn{border:0;background:transparent;color:var(--aic-accent);padding:3px;cursor:pointer;font-size:11px}.aic-mini-btn:hover{text-decoration:underline}
.aic-text-edit{display:block;width:100%;height:128px;padding:10px 11px;resize:none;border:1px solid var(--aic-border);border-radius:8px;background:var(--aic-input);color:var(--aic-text);line-height:1.65;font-size:12px;cursor:text;user-select:text}.aic-text-edit::placeholder{color:var(--aic-muted)}.aic-node-foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;color:var(--aic-muted);font-size:10px}.aic-ref-count{color:var(--aic-accent)}
.aic-image-wrap{height:214px;border-radius:8px;overflow:hidden;background:var(--aic-input);display:grid;place-items:center;cursor:pointer}.aic-image-wrap img{display:block;width:100%;height:100%;object-fit:cover}.aic-result-meta{padding:9px 2px 1px;color:var(--aic-muted);font-size:10px;line-height:1.6;word-break:break-word}.aic-result-actions{display:flex;gap:6px;padding:9px 11px 11px}.aic-result-actions .aic-btn{flex:1;min-height:29px;padding:4px 8px;font-size:11px}.aic-spinner{width:22px;height:22px;border:2px solid var(--aic-border);border-top-color:var(--aic-accent);border-radius:50%;animation:aic-spin .8s linear infinite}.aic-progress{height:3px;background:var(--aic-border);border-radius:3px;overflow:hidden}.aic-progress span{display:block;width:35%;height:100%;background:var(--aic-accent);animation:aic-progress 1.4s ease-in-out infinite}@keyframes aic-spin{to{transform:rotate(360deg)}}@keyframes aic-progress{0%{transform:translateX(-110%)}100%{transform:translateX(300%)}}
.aic-toolbar{position:absolute;z-index:16;left:16px;top:79px;display:flex;flex-direction:column;gap:5px;padding:6px;border:1px solid var(--aic-border);border-radius:12px;background:var(--aic-panel);box-shadow:0 6px 22px rgba(0,0,0,.14)}.aic-toolbar .aic-btn{width:34px;height:34px;min-height:34px;padding:0}.aic-tool-sep{height:1px;background:var(--aic-border);margin:3px 4px}
.aic-zoom{position:absolute;z-index:16;right:18px;bottom:174px;display:flex;align-items:center;gap:3px;padding:4px;border:1px solid var(--aic-border);border-radius:9px;background:var(--aic-panel)}.aic-zoom button{height:28px;min-width:28px;padding:0 7px}.aic-zoom-value{min-width:48px;text-align:center;color:var(--aic-muted);font-size:11px}
.aic-dock{position:absolute;z-index:18;left:50%;bottom:16px;transform:translateX(-50%);width:min(940px,calc(100% - 40px));border:1px solid var(--aic-border);border-radius:15px;background:var(--aic-panel);box-shadow:0 18px 60px rgba(0,0,0,.35);padding:11px 13px}.aic-dock-top{display:flex;align-items:center;gap:8px;margin-bottom:8px}.aic-dock-top .aic-btn{min-height:29px;padding:4px 9px;font-size:11px}.aic-dock-status{margin-left:auto;color:var(--aic-muted);font-size:11px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aic-dock-main{display:flex;gap:10px;align-items:flex-end}.aic-prompt-wrap{flex:1;min-width:170px;position:relative}.aic-prompt{display:block;width:100%;height:62px;min-height:62px;max-height:110px;padding:10px 12px 20px;resize:vertical;border:1px solid var(--aic-border);border-radius:9px;background:var(--aic-input);color:var(--aic-text);font-size:12px;line-height:1.55}.aic-prompt::placeholder{color:var(--aic-muted)}.aic-prompt-count{position:absolute;right:9px;bottom:6px;color:var(--aic-muted);font-size:10px;pointer-events:none}.aic-controls{display:flex;gap:7px;align-items:flex-end;flex-wrap:wrap;justify-content:flex-end}.aic-field{display:flex;flex-direction:column;gap:3px}.aic-field label{color:var(--aic-muted);font-size:10px;padding-left:2px}.aic-select,.aic-number{height:34px;border:1px solid var(--aic-border);border-radius:7px;background:var(--aic-input);color:var(--aic-text);padding:0 8px;font-size:11px;max-width:150px}.aic-field.provider{min-width:112px}.aic-field.model{min-width:142px;max-width:190px}.aic-field.model .aic-select{width:100%}.aic-field.size{min-width:112px}.aic-field.count{min-width:55px}.aic-number{width:55px}.aic-generate{height:34px;min-height:34px}.aic-more-row{display:none;gap:8px;align-items:flex-end;padding-top:10px;margin-top:10px;border-top:1px solid var(--aic-border);flex-wrap:wrap}.aic-more-row.open{display:flex}.aic-more-row .aic-field{flex:1;min-width:160px}.aic-more-row input{width:100%;height:32px;border:1px solid var(--aic-border);border-radius:7px;background:var(--aic-input);color:var(--aic-text);padding:0 9px;font-size:11px}.aic-shortcut{color:var(--aic-muted);font-size:10px;margin-left:3px}
.aic-menu{position:absolute;z-index:50;min-width:194px;padding:5px;border:1px solid var(--aic-border);border-radius:10px;background:var(--aic-panel);box-shadow:0 12px 38px rgba(0,0,0,.35)}.aic-menu[hidden]{display:none}.aic-menu button{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:6px;background:transparent;color:var(--aic-text);text-align:left;cursor:pointer;font-size:12px}.aic-menu button:hover,.aic-menu button:focus-visible{background:var(--aic-panel-2)}.aic-menu button:disabled{opacity:.35;cursor:not-allowed}.aic-menu .danger{color:var(--aic-danger)}.aic-menu-sep{height:1px;background:var(--aic-border);margin:4px 5px}.aic-menu-hint{padding:5px 9px;color:var(--aic-muted);font-size:10px}
.aic-toast{position:absolute;z-index:70;left:50%;top:76px;transform:translateX(-50%);max-width:min(560px,90%);padding:9px 14px;border:1px solid var(--aic-border);border-radius:9px;background:var(--aic-panel);box-shadow:0 8px 28px rgba(0,0,0,0.28);font-size:12px;pointer-events:none;word-break:break-word}.aic-toast.error{border-color:var(--aic-danger);color:var(--aic-danger)}.aic-toast.success{border-color:var(--aic-success)}.aic-toast[hidden]{display:none}.aic-link-tip{position:absolute;z-index:15;left:50%;top:76px;transform:translateX(-50%);padding:7px 12px;border-radius:20px;background:var(--aic-accent-2);color:#fff;font-size:11px;pointer-events:none}.aic-link-tip[hidden]{display:none}
.aic-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.aic-empty-state{position:absolute;z-index:5;left:50%;top:43%;transform:translate(-50%,-50%);text-align:center;color:var(--aic-muted);pointer-events:none}.aic-empty-state strong{display:block;color:var(--aic-text);font-size:17px;margin-bottom:6px}.aic-empty-state[hidden]{display:none}
@media(max-width:1050px){.aic-brand{min-width:160px}.aic-date{display:none}.aic-controls{max-width:410px}.aic-field.model{min-width:120px}.aic-field.provider{min-width:100px}}
@media(max-width:760px){.aic{min-height:500px}.aic-top{height:54px;padding:8px 10px;gap:8px}.aic-brand{min-width:0;flex:1}.aic-logo{width:28px;height:28px;border-radius:8px}.aic-project{font-size:12px}.aic-top-actions{gap:5px}.aic-top-actions .aic-btn{min-height:30px;padding:5px 8px;font-size:11px}.aic-quota{display:none}.aic-viewport{inset:54px 0 0}.aic-toolbar{left:8px;top:65px;padding:4px}.aic-toolbar .aic-btn{width:31px;height:31px;min-height:31px}.aic-dock{left:8px;right:8px;bottom:8px;width:auto;transform:none;padding:9px;max-height:47vh;overflow:auto}.aic-dock-main{flex-wrap:wrap}.aic-prompt-wrap{flex-basis:100%}.aic-prompt{height:55px;min-height:55px}.aic-controls{max-width:none;width:100%;flex-wrap:nowrap;justify-content:flex-start;overflow-x:auto;padding-bottom:3px}.aic-field.provider{min-width:104px}.aic-field.model{min-width:132px}.aic-field.size{min-width:108px}.aic-field.count{min-width:52px}.aic-generate{margin-left:auto}.aic-shortcut{display:none}.aic-dock-status{max-width:38%}.aic-zoom{right:10px;bottom:210px}.aic-node{box-shadow:0 8px 24px rgba(0,0,0,0.25)}}
@media(max-width:460px){.aic-brand .aic-project{max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aic-top-actions .mode-label{display:none}.aic-dock-top{flex-wrap:wrap}.aic-dock-status{max-width:100%;margin-left:0;order:3;width:100%}.aic-toolbar{top:63px}.aic-zoom{bottom:228px}}
.aic-thumb img[hidden],.aic-image-wrap img[hidden]{display:none}
.aic-guide{stroke:var(--aic-success);stroke-width:1;stroke-dasharray:4 4;vector-effect:non-scaling-stroke;opacity:.95}
.aic-marquee{position:absolute;z-index:13;border:1px solid var(--aic-accent);background:color-mix(in srgb,var(--aic-accent) 12%,transparent);border-radius:2px;pointer-events:none;display:none}
.aic-marquee.show{display:block}
.aic-node.locked{cursor:default;box-shadow:0 6px 18px rgba(0,0,0,.18)}
.aic-node-lock{font-size:10px;line-height:1;color:var(--aic-muted);flex:none}
.aic-align{position:absolute;z-index:17;left:50%;top:73px;transform:translateX(-50%);display:none;align-items:center;gap:4px;padding:5px 7px;border:1px solid var(--aic-border);border-radius:10px;background:var(--aic-panel);box-shadow:0 10px 30px rgba(0,0,0,.28);max-width:calc(100% - 32px);overflow-x:auto}
.aic-align.show{display:flex}
.aic-align .aic-btn{width:30px;height:30px;min-height:30px;padding:0;font-size:13px;flex:none}
.aic-align-count{color:var(--aic-muted);font-size:11px;padding:0 5px;white-space:nowrap;flex:none}
.aic-align-sep{width:1px;height:18px;background:var(--aic-border);margin:0 2px;flex:none}
.aic-minimap{position:absolute;z-index:16;right:16px;top:78px;width:198px;padding:6px;border:1px solid var(--aic-border);border-radius:10px;background:var(--aic-panel);box-shadow:0 8px 26px rgba(0,0,0,.22);display:none}
.aic-minimap.show{display:block}
.aic-minimap canvas{display:block;width:184px;height:120px;border-radius:6px;background:var(--aic-input);cursor:crosshair;touch-action:none}
.aic-minimap-label{display:flex;justify-content:space-between;color:var(--aic-muted);font-size:10px;padding:4px 2px 0}
.aic-help-mask{position:absolute;inset:0;z-index:80;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.52)}
.aic-help-mask.show{display:flex}
.aic-help{width:min(580px,100%);max-height:min(82%,640px);overflow:auto;padding:18px 20px 20px;border:1px solid var(--aic-border);border-radius:14px;background:var(--aic-panel);box-shadow:0 24px 70px rgba(0,0,0,.45)}
.aic-help-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
.aic-help-title{font-size:15px;font-weight:650}
.aic-help-sub{color:var(--aic-muted);font-size:11px;line-height:1.7;margin-bottom:12px}
.aic-help-close{width:30px;height:30px;padding:0}
.aic-help-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px}
.aic-help-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px dashed var(--aic-border);font-size:12px}
.aic-help-row span{color:var(--aic-muted)}
.aic-help-section{grid-column:1/-1;margin-top:10px;color:var(--aic-accent);font-size:11px;font-weight:650;letter-spacing:.04em}
.aic-help kbd{display:inline-block;min-width:18px;padding:2px 5px;border:1px solid var(--aic-border);border-bottom-width:2px;border-radius:5px;background:var(--aic-input);color:var(--aic-text);font-family:inherit;font-size:10px;text-align:center;white-space:nowrap}
@media(max-width:900px){.aic-minimap{display:none!important}.aic-align{top:62px}.aic-help-grid{grid-template-columns:1fr}}
@media(max-width:760px){.aic-align{display:none!important}}
@media(prefers-reduced-motion:reduce){.aic-spinner,.aic-progress span{animation-duration:2.5s}.aic-node,.aic-btn{transition:none}}
`;

  var ICONS = {
    text: 'T', image: 'I', upload: '↑', plus: '+', minus: '−', fit: '⌖',
    undo: '↶', redo: '↷', moon: '◐', more: '⋯', hand: '✥', cursor: '↖',
    download: '↓', close: '×', copy: '▢', trash: '×', settings: '⚙', spark: '✦',
    grid: '⊞', minimap: '▤', help: '?', lock: '🔒', left: '⊢', hcenter: '⊹',
    right: '⊣', top: '⊤', vcenter: '⊕', bottom: '⊥', distH: '⇹', distV: '⇳',
    arrange: '▦', zoomSelection: '⛶', check: '✓'
  };

  function iconButton(icon, title, className) {
    var button = make('button', 'aic-btn aic-icon-btn' + (className ? ' ' + className : ''), ICONS[icon] || icon);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
  }

  function selectField(label, className, values) {
    var wrap = make('div', 'aic-field ' + className);
    wrap.appendChild(make('label', '', label));
    var select = make('select', 'aic-select');
    select.setAttribute('aria-label', label);
    values.forEach(function (value) {
      var option = make('option', '', value.label);
      option.value = value.value;
      select.appendChild(option);
    });
    wrap.appendChild(select);
    return { wrap: wrap, input: select };
  }

  function validNode(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (['upload', 'text', 'image'].indexOf(raw.type) === -1) return null;
    if (typeof raw.id !== 'string' || !/^aic-[a-z0-9-]{1,90}$/i.test(raw.id)) return null;
    if (typeof raw.x !== 'number' || !isFinite(raw.x) || typeof raw.y !== 'number' || !isFinite(raw.y)) return null;
    return {
      id: raw.id,
      type: raw.type,
      x: clamp(raw.x, -100000, 100000),
      y: clamp(raw.y, -100000, 100000),
      text: safeText(raw.text, '', 12000),
      name: safeText(raw.name, raw.type === 'text' ? 'Text 提示词' : raw.type === 'upload' ? '参考图片' : 'Image 结果', 180),
      url: safeImageUrl(raw.url),
      path: safeText(raw.path, '', 2000),
      blobId: typeof raw.blobId === 'string' && /^aic-[a-z0-9-]{1,90}$/i.test(raw.blobId) ? raw.blobId : '',
      mime: typeof raw.mime === 'string' ? raw.mime.slice(0, 80) : '',
      provider: safeText(raw.provider, '', 120),
      model: safeText(raw.model, '', 200),
      prompt: safeText(raw.prompt, '', 12000),
      size: safeText(raw.size, '', 40),
      status: safeText(raw.status, '', 30),
      locked: Boolean(raw.locked)
    };
  }

  function sanitizeState(raw) {
    var clean = { nodes: [], edges: [], viewport: null, prompt: '', activeTextId: '', prefs: null };
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return clean;
    var seen = {};
    raw.nodes.slice(0, MAX_NODES).forEach(function (item) {
      var node = validNode(item);
      if (node && !seen[node.id]) {
        seen[node.id] = true;
        // 进行中的任务不可能跨页面恢复，安全降级为普通节点。
        if (node.status === 'generating') node.status = '';
        clean.nodes.push(node);
      }
    });
    (Array.isArray(raw.edges) ? raw.edges : []).slice(0, 600).forEach(function (edge) {
      if (!edge || seen[edge.from] && seen[edge.to] && edge.from !== edge.to && typeof edge.id === 'string' && /^edge-[a-z0-9-]{1,90}$/i.test(edge.id)) {
        clean.edges.push({ id: edge.id, from: edge.from, to: edge.to });
      }
    });
    if (raw.viewport && isFinite(raw.viewport.x) && isFinite(raw.viewport.y) && isFinite(raw.viewport.scale)) {
      clean.viewport = { x: clamp(raw.viewport.x, -100000, 100000), y: clamp(raw.viewport.y, -100000, 100000), scale: clamp(raw.viewport.scale, 0.2, 2.5) };
    }
    clean.prompt = safeText(raw.prompt, '', 12000);
    clean.activeTextId = seen[raw.activeTextId] && raw.activeTextId ? raw.activeTextId : '';
    if (raw.prefs && typeof raw.prefs === 'object') {
      clean.prefs = {
        provider: safeText(raw.prefs.provider, '', 120),
        model: safeText(raw.prefs.model, '', 200),
        size: safeText(raw.prefs.size, '', 40),
        n: clamp(Number(raw.prefs.n) || 1, 1, 4),
        seed: safeText(raw.prefs.seed, '', 30),
        style: safeText(raw.prefs.style, '', 200),
        negativePrompt: safeText(raw.prefs.negativePrompt, '', 4000)
      };
    }
    return clean;
  }

  function restoreState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return sanitizeState(null);
      return sanitizeState(JSON.parse(raw));
    } catch (err) {
      return sanitizeState(null);
    }
  }

  function cloneState(state) {
    return {
      nodes: state.nodes.map(function (node) { return Object.assign({}, node); }),
      edges: state.edges.map(function (edge) { return Object.assign({}, edge); }),
      viewport: state.viewport ? Object.assign({}, state.viewport) : null,
      prompt: state.prompt,
      activeTextId: state.activeTextId,
      prefs: state.prefs ? Object.assign({}, state.prefs) : null
    };
  }

  window.aiImageInitCanvas = function () {
    var root = document.getElementById('aiimgCanvasRoot');
    if (!root) return null;
    if (initializedRoot === root && root.__aiImageCanvas) return root.__aiImageCanvas;
    if (initializedRoot && initializedRoot.__aiImageCanvas && typeof initializedRoot.__aiImageCanvas.destroy === 'function') {
      initializedRoot.__aiImageCanvas.destroy();
    }
    initializedRoot = root;
    return createCanvas(root);
  };

  if (!readyHandler) {
    readyHandler = function () {
      var canvas = window.aiImageInitCanvas();
      if (canvas && typeof canvas.refresh === 'function') canvas.refresh();
    };
    on(window, 'ai-image-canvas-ready', readyHandler);
  }
  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', readyHandler);
  } else {
    window.aiImageInitCanvas();
  }

  function createCanvas(root) {
    var pageData = readDataElement();
    var state = restoreState();
    var providers = Array.isArray(pageData.providers) ? pageData.providers.filter(function (p) {
      return p && typeof p.provider_key === 'string';
    }).map(function (p) {
      return {
        provider_key: p.provider_key.slice(0, 120),
        name: safeText(p.name, p.provider_key, 100),
        default_model: safeText(p.default_model, '', 200),
        models: Array.isArray(p.models) ? p.models.filter(function (m) { return typeof m === 'string'; }).slice(0, 200) : [],
        supports_negative: Boolean(p.supports_negative),
        supports_n: Boolean(p.supports_n),
        supports_img2img: Boolean(p.supports_img2img)
      };
    }) : [];
    var theme = loadTheme();
    var nodes = state.nodes;
    var edges = state.edges;
    var activeTextId = state.activeTextId;
    var selectedIds = [];
    var selectedId = '';
    var selectedEdgeId = '';
    var viewport = state.viewport || { x: 70, y: 80, scale: 1 };
    var prefs = state.prefs || {};
    var undoStack = [];
    var redoStack = [];
    var saveTimer = null;
    var toastTimer = null;
    var drag = null;
    var pan = null;
    var link = null;
    var marquee = null;
    var clipboard = null;
    var snapEnabled = loadFlag(SNAP_KEY, true);
    var minimapVisible = loadFlag(MINIMAP_KEY, true);
    var minimapRaf = 0;
    var miniView = null;
    var minimapDragging = false;
    var spaceDown = false;
    var savedAt = 0;
    var generating = false;
    var preparing = false;
    var currentTask = null;
    var generationNodeIds = [];
    var destroyHandlers = [];
    var objectUrls = [];
    var fileBlobs = {};
    var blobLoads = {};
    var blobWrites = {};
    var pendingUploadLink = false;
    var fitWhenVisible = !state.viewport;
    var destroyed = false;

    root.textContent = '';
    root.classList.add('aic');
    root.classList.toggle('light', theme === 'light');
    root.setAttribute('aria-label', 'AI 生图节点画布');

    var style = make('style');
    style.textContent = CSS;
    root.appendChild(style);
    // 画布通道新增元素（自定义尺寸 / 协作光标 / 保存状态）的样式，避免改动主 CSS 大字符串。
    var extraStyle = make('style');
    extraStyle.textContent = [
      // hidden 属性会被 .aic-btn 的 display 覆盖，这里统一兜底，避免隐藏按钮实际仍可见
      '.aic [hidden]{display:none!important}',
      '.aic-custom-dim{display:flex;align-items:center;gap:4px;margin-top:4px}',
      '.aic-custom-input{width:66px;padding:3px 5px;border:1px solid var(--aic-border);border-radius:5px;',
      'background:var(--aic-input);color:var(--aic-text);font-size:11px}',
      '.aic-custom-x{opacity:.6;font-size:11px}',
      '.aic-peers{position:absolute;inset:0;pointer-events:none;z-index:19}',
      '.aic-peer{position:absolute;display:flex;align-items:center;gap:4px;font-size:11px;color:#fff;',
      'background:var(--aic-accent);padding:1px 6px;border-radius:9px;white-space:nowrap;',
      'box-shadow:0 2px 8px rgba(0,0,0,.3);will-change:transform}',
      '.aic-peer-dot{width:5px;height:5px;border-radius:50%;background:#fff;opacity:.9}'
    ].join('');
    root.appendChild(extraStyle);

    var top = make('header', 'aic-top');
    var brand = make('div', 'aic-brand');
    brand.appendChild(make('div', 'aic-logo', 'AI'));
    var titles = make('div');
    titles.appendChild(make('div', 'aic-project', 'AI 图像创作'));
    var dateText = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    var projectMeta = make('div', 'aic-date', dateText + ' · ' + (CFG.projectName || '未命名项目'));
    titles.appendChild(projectMeta);
    brand.appendChild(titles);
    top.appendChild(brand);
    var topActions = make('div', 'aic-top-actions');
    var quota = make('span', 'aic-quota');
    quota.setAttribute('aria-live', 'polite');
    topActions.appendChild(quota);
    var projectButton = make('button', 'aic-btn', '项目');
    projectButton.type = 'button';
    projectButton.title = '项目：导入 / 导出 / 自动布局 / 清空画布';
    topActions.appendChild(projectButton);
    if (SERVER) {
      var collabButton = make('button', 'aic-btn', '协作');
      collabButton.type = 'button';
      collabButton.title = '成员、分享与在线状态';
      bind(collabButton, 'click', function () {
        if (typeof CFG.onOpenCollab === 'function') CFG.onOpenCollab();
      });
      topActions.appendChild(collabButton);
    }
    var helpButton = iconButton('help', '快捷键与帮助');
    topActions.appendChild(helpButton);
    var simpleButton = make('button', 'aic-btn', '简洁表单');
    simpleButton.type = 'button';
    simpleButton.title = '切换到简洁表单模式';
    topActions.appendChild(simpleButton);
    if (STANDALONE) simpleButton.hidden = true;
    var saveStateLabel = make('span', 'aic-date', '');
    topActions.appendChild(saveStateLabel);
    var themeButton = iconButton('moon', '切换亮色 / 暗色主题');
    themeButton.textContent = theme === 'dark' ? '亮' : '暗';
    topActions.appendChild(themeButton);
    top.appendChild(topActions);
    root.appendChild(top);

    var viewportEl = make('div', 'aic-viewport');
    viewportEl.setAttribute('role', 'application');
    viewportEl.setAttribute('aria-label', '画布：拖动空白处平移，滚轮缩放，右键添加节点');
    var world = make('div', 'aic-world');
    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'aic-edges');
    svg.setAttribute('aria-hidden', 'true');
    var tempPath = document.createElementNS(svgNs, 'path');
    tempPath.setAttribute('class', 'aic-temp-edge');
    tempPath.style.display = 'none';
    svg.appendChild(tempPath);
    var guideGroup = document.createElementNS(svgNs, 'g');
    guideGroup.setAttribute('class', 'aic-guides');
    svg.appendChild(guideGroup);
    world.appendChild(svg);
    viewportEl.appendChild(world);
    root.appendChild(viewportEl);

    var emptyState = make('div', 'aic-empty-state');
    emptyState.appendChild(make('strong', '', '从一个想法开始'));
    emptyState.appendChild(make('span', '', '上传参考图或添加 Text 节点，也可以直接在下方输入提示词'));
    root.appendChild(emptyState);

    var toolbar = make('div', 'aic-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', '画布工具');
    var handButton = iconButton('hand', '平移画布');
    handButton.classList.add('active');
    var cursorButton = iconButton('cursor', '选择节点');
    var toolSep1 = make('div', 'aic-tool-sep');
    var addTextButton = iconButton('text', '添加 Text 提示词节点');
    var addUploadButton = iconButton('upload', '上传参考图片');
    var addImageButton = iconButton('image', '添加空白 Image 节点');
    var toolSep2 = make('div', 'aic-tool-sep');
    var fitButton = iconButton('fit', '适应视图');
    var undoButton = iconButton('undo', '撤销');
    var redoButton = iconButton('redo', '重做');
    var toolSep3 = make('div', 'aic-tool-sep');
    var snapButton = iconButton('grid', '智能吸附：网格对齐 + 节点参考线');
    snapButton.classList.toggle('active', snapEnabled);
    snapButton.setAttribute('aria-pressed', snapEnabled ? 'true' : 'false');
    var minimapButton = iconButton('minimap', '显示 / 隐藏小地图');
    minimapButton.classList.toggle('active', minimapVisible);
    minimapButton.setAttribute('aria-pressed', minimapVisible ? 'true' : 'false');
    [handButton, cursorButton, toolSep1, addTextButton, addUploadButton, addImageButton, toolSep2, fitButton, undoButton, redoButton, toolSep3, snapButton, minimapButton].forEach(function (el) { toolbar.appendChild(el); });
    root.appendChild(toolbar);

    var alignBar = make('div', 'aic-align');
    alignBar.setAttribute('role', 'toolbar');
    alignBar.setAttribute('aria-label', '选中节点排列工具');
    var alignCount = make('span', 'aic-align-count', '已选 0 个');
    alignBar.appendChild(alignCount);
    var alignButtons = [];
    function addAlignButton(icon, title, action, minCount) {
      var button = iconButton(icon, title);
      button.dataset.minCount = String(minCount || 2);
      button.disabled = true;
      bind(button, 'click', function () { action(); });
      alignBar.appendChild(button);
      alignButtons.push(button);
      return button;
    }
    addAlignButton('left', '左对齐', function () { alignSelection('left'); }, 2);
    addAlignButton('hcenter', '水平居中对齐', function () { alignSelection('hcenter'); }, 2);
    addAlignButton('right', '右对齐', function () { alignSelection('right'); }, 2);
    alignBar.appendChild(make('div', 'aic-align-sep'));
    addAlignButton('top', '顶对齐', function () { alignSelection('top'); }, 2);
    addAlignButton('vcenter', '垂直居中对齐', function () { alignSelection('vcenter'); }, 2);
    addAlignButton('bottom', '底对齐', function () { alignSelection('bottom'); }, 2);
    alignBar.appendChild(make('div', 'aic-align-sep'));
    addAlignButton('distH', '水平等距分布（至少 3 个）', function () { distributeSelection('h'); }, 3);
    addAlignButton('distV', '垂直等距分布（至少 3 个）', function () { distributeSelection('v'); }, 3);
    addAlignButton('arrange', '整理为网格', arrangeSelection, 2);
    addAlignButton('zoomSelection', '缩放到选中节点', zoomToSelection, 2);
    var alignDelete = addAlignButton('trash', '删除选中节点', deleteSelection, 1);
    alignDelete.classList.add('danger');
    root.appendChild(alignBar);

    var zoom = make('div', 'aic-zoom');
    var zoomOut = iconButton('minus', '缩小');
    var zoomValue = make('span', 'aic-zoom-value', '100%');
    zoomValue.title = '点击恢复 100%';
    zoomValue.setAttribute('role', 'button');
    zoomValue.setAttribute('tabindex', '0');
    zoomValue.style.cursor = 'pointer';
    var zoomIn = iconButton('plus', '放大');
    var zoomFit = make('button', 'aic-btn aic-icon-btn', ICONS.fit);
    zoomFit.type = 'button';
    zoomFit.title = '适应视图';
    zoomFit.setAttribute('aria-label', '适应视图');
    [zoomOut, zoomValue, zoomIn, zoomFit].forEach(function (el) { zoom.appendChild(el); });
    root.appendChild(zoom);

    var minimapPanel = make('div', 'aic-minimap' + (minimapVisible ? ' show' : ''));
    var miniCanvas = make('canvas');
    miniCanvas.setAttribute('aria-label', '画布小地图，点击或拖动可快速跳转');
    minimapPanel.appendChild(miniCanvas);
    var miniLabel = make('div', 'aic-minimap-label');
    miniLabel.appendChild(make('span', '', '小地图'));
    var miniZoomLabel = make('span', '', '100%');
    miniLabel.appendChild(miniZoomLabel);
    minimapPanel.appendChild(miniLabel);
    root.appendChild(minimapPanel);

    var linkTip = make('div', 'aic-link-tip', '请选择 Text 或 Image 左侧输入锚点');
    linkTip.hidden = true;
    root.appendChild(linkTip);

    var marqueeEl = make('div', 'aic-marquee');
    viewportEl.appendChild(marqueeEl);

    var dock = make('section', 'aic-dock');
    dock.setAttribute('aria-label', '生图提示词控制台');
    var dockTop = make('div', 'aic-dock-top');
    var referenceButton = make('button', 'aic-btn', '+ 参考');
    referenceButton.type = 'button';
    referenceButton.title = '上传图片并连接到当前 Text 节点';
    var nodeButton = make('button', 'aic-btn', '+ 图片节点');
    nodeButton.type = 'button';
    var moreNodeButton = make('button', 'aic-btn', '+ 更多节点');
    moreNodeButton.type = 'button';
    var moreSettingsButton = make('button', 'aic-btn', '参数设置');
    moreSettingsButton.type = 'button';
    moreSettingsButton.setAttribute('aria-expanded', 'false');
    var dockStatus = make('span', 'aic-dock-status', '就绪');
    dockStatus.setAttribute('aria-live', 'polite');
    [referenceButton, nodeButton, moreNodeButton, moreSettingsButton, dockStatus].forEach(function (el) { dockTop.appendChild(el); });
    dock.appendChild(dockTop);

    var dockMain = make('div', 'aic-dock-main');
    var promptWrap = make('div', 'aic-prompt-wrap');
    var promptInput = make('textarea', 'aic-prompt');
    promptInput.placeholder = '描述你想创作的画面…';
    promptInput.setAttribute('aria-label', '生图提示词');
    promptInput.maxLength = 12000;
    var promptCount = make('span', 'aic-prompt-count', '0 / 12000');
    promptWrap.appendChild(promptInput);
    promptWrap.appendChild(promptCount);
    dockMain.appendChild(promptWrap);

    var controls = make('div', 'aic-controls');
    var providerField = selectField('服务商', 'provider', providers.length ? providers.map(function (p) { return { value: p.provider_key, label: p.name || p.provider_key }; }) : [{ value: '', label: '暂无服务商' }]);
    var modelField = selectField('模型', 'model', [{ value: '', label: '默认模型' }]);
    var sizeValues = Array.isArray(pageData.sizePresets) && pageData.sizePresets.length
      ? pageData.sizePresets.filter(function (preset) {
        return preset && typeof preset.value === 'string' && /^\d{1,5}[x*]\d{1,5}$/i.test(preset.value);
      }).map(function (preset) {
        return { value: preset.value.replace(/\*/g, 'x'), label: safeText(preset.label, preset.value, 80) };
      })
      : ['1024x1024', '1024x1792', '1792x1024', '1536x1024', '1024x1536'].map(function (v) { return { value: v, label: v }; });
    if (!sizeValues.some(function (item) { return item.value === '1024x1024'; })) {
      sizeValues.push({ value: '1024x1024', label: '1024 × 1024（方形）' });
    }
    // 旧版像素尺寸下拉保留为兼容值（隐藏），实际由「比例 + 画质」推导，与 TTAI 插件的尺寸逻辑一致。
    var sizeField = selectField('尺寸', 'size', sizeValues);
    sizeField.input.title = '4K 需要服务商/模型支持；不支持时自动降级到最接近的尺寸';
    sizeField.wrap.style.display = 'none';

    var ratioOptions = Array.isArray(pageData.ratios) && pageData.ratios.length
      ? pageData.ratios.map(function (r) { return { value: String(r.value), label: safeText(r.label, r.value, 40) }; })
      : [{ value: 'auto', label: '自适应' }, { value: '1:1', label: '1:1' }, { value: '16:9', label: '16:9' },
        { value: '9:16', label: '9:16' }, { value: '4:3', label: '4:3' }, { value: '3:4', label: '3:4' },
        { value: '3:2', label: '3:2' }, { value: '2:3', label: '2:3' }];
    var ratioField = selectField('比例', 'ratio', ratioOptions);
    ratioField.input.value = '1:1';
    ratioField.input.title = '画面比例；自适应按参考图/服务商默认';

    var qualityOptions = (Array.isArray(pageData.qualities) && pageData.qualities.length
      ? pageData.qualities.map(function (q) { return { value: String(q.value), label: safeText(q.label, q.value, 40) }; })
      : [{ value: '1k', label: '1K' }, { value: '2k', label: '2K' }, { value: '4k', label: '4K' }]);
    if (CUSTOM_SIZE) qualityOptions.push({ value: '__custom__', label: '自定义宽 × 高…' });
    var qualityField = selectField('画质', 'quality', qualityOptions);
    qualityField.input.title = '长边 1K/2K/4K；4K 需服务商与模型支持，不支持时自动降级';
    qualityField.input.value = '1k';

    var customWidthInput = null;
    var customHeightInput = null;
    var customDim = null;
    if (CUSTOM_SIZE) {
      customDim = make('div', 'aic-custom-dim');
      customWidthInput = make('input', 'aic-custom-input');
      customWidthInput.type = 'number';
      customWidthInput.min = '64';
      customWidthInput.max = '4096';
      customWidthInput.step = '8';
      customWidthInput.value = '1024';
      customWidthInput.title = '宽度 64–4096（自动取 8 的倍数）';
      customHeightInput = make('input', 'aic-custom-input');
      customHeightInput.type = 'number';
      customHeightInput.min = '64';
      customHeightInput.max = '4096';
      customHeightInput.step = '8';
      customHeightInput.value = '1024';
      customHeightInput.title = '高度 64–4096（自动取 8 的倍数）';
      customDim.appendChild(customWidthInput);
      customDim.appendChild(make('span', 'aic-custom-x', '×'));
      customDim.appendChild(customHeightInput);
      customDim.hidden = true;
      qualityField.wrap.appendChild(customDim);
      bind(qualityField.input, 'change', function () {
        customDim.hidden = qualityField.input.value !== '__custom__';
      });
    }

    function matrixSize(ratio, quality) {
      var matrix = pageData.sizeMatrix || {};
      var tier = matrix[quality];
      if (!tier) return '';
      return tier[ratio] || tier['1:1'] || '';
    }

    // 当前生效尺寸：比例 + 画质（或自定义宽高）。
    function currentSizeValue() {
      if (qualityField.input.value === '__custom__') {
        var w = clamp(Math.round((parseInt(customWidthInput && customWidthInput.value, 10) || 1024) / 8) * 8, 64, 4096);
        var h = clamp(Math.round((parseInt(customHeightInput && customHeightInput.value, 10) || 1024) / 8) * 8, 64, 4096);
        return w + 'x' + h;
      }
      var computed = matrixSize(ratioField.input.value, qualityField.input.value);
      if (computed) return computed;
      // 兜底：老页面数据没有 sizeMatrix 时退回像素下拉
      return sizeField.input.value || '1024x1024';
    }

    function syncLegacySize() {
      var value = currentSizeValue();
      if (!value) return;
      if (Array.prototype.some.call(sizeField.input.options, function (o) { return o.value === value; })) {
        sizeField.input.value = value;
      } else {
        var option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        sizeField.input.appendChild(option);
        sizeField.input.value = value;
      }
    }
    bind(ratioField.input, 'change', syncLegacySize);
    bind(qualityField.input, 'change', syncLegacySize);

    var countField = selectField('数量', 'count', [1, 2, 3, 4].map(function (v) { return { value: String(v), label: v + ' 张' }; }));
    var generateButton = make('button', 'aic-btn primary aic-generate', '生成图片');
    generateButton.type = 'button';
    generateButton.title = '生成图片（Ctrl / Command + Enter）';
    [providerField.wrap, modelField.wrap, ratioField.wrap, qualityField.wrap, countField.wrap, generateButton].forEach(function (el) { controls.appendChild(el); });
    // 提示词优化：与基础页同一套后台 LLM（/ai-canvas/api/enhance-prompt）
    if (typeof window.aiImageEnhancePrompt === 'function') {
      var enhanceButton = make('button', 'aic-btn', '✨ 优化');
      enhanceButton.type = 'button';
      enhanceButton.title = '用后台配置的 LLM 优化当前提示词';
      bind(enhanceButton, 'click', function () {
        var value = promptInput.value.trim();
        if (!value) { notify('先输入提示词再优化', 'warning'); return; }
        enhanceButton.disabled = true;
        Promise.resolve(window.aiImageEnhancePrompt(value)).then(function (enhanced) {
          enhanceButton.disabled = false;
          if (!enhanced) return;
          promptInput.value = enhanced;
          updatePromptCount();
          scheduleSave();
          notify('提示词已优化', 'success');
        }, function (err) {
          enhanceButton.disabled = false;
          notify('优化失败：' + errorMessage(err), 'error');
        });
      });
      controls.appendChild(enhanceButton);
    }
    dockMain.appendChild(controls);
    dock.appendChild(dockMain);

    var moreRow = make('div', 'aic-more-row');
    var seedField = selectField('随机种子（留空为随机）', 'seed', []);
    seedField.input.remove();
    var seedInput = make('input');
    seedInput.type = 'text';
    seedInput.inputMode = 'numeric';
    seedInput.placeholder = '例如 123456';
    seedInput.maxLength = 30;
    seedField.wrap.appendChild(seedInput);
    seedField.input = seedInput;
    var styleData = pageData.stylePresets && typeof pageData.stylePresets === 'object' ? pageData.stylePresets : {};
    var styleLabels = { photo: '摄影写实', illustration: '数字插画', '3d': '3D 渲染', guofeng: '国风', cyberpunk: '赛博朋克', watercolor: '水彩', anime: '动漫' };
    var styleValues = [{ value: '', label: '无指定风格' }].concat(Object.keys(styleData).map(function (key) {
      var value = styleData[key];
      var fallback = value && typeof value === 'object' ? value.name || value.label || key : key;
      return { value: key, label: safeText(styleLabels[key] || fallback, key, 80) };
    }));
    var styleField = selectField('风格', 'style', styleValues);
    var negativeField = make('div', 'aic-field negative-field');
    negativeField.appendChild(make('label', '', '负面提示词'));
    var negativeInput = make('input');
    negativeInput.type = 'text';
    negativeInput.placeholder = '不希望出现的内容';
    negativeInput.maxLength = 4000;
    negativeField.appendChild(negativeInput);
    var cancelButton = make('button', 'aic-btn danger', '取消生成');
    cancelButton.type = 'button';
    cancelButton.hidden = true;
    moreRow.appendChild(seedField.wrap);
    moreRow.appendChild(styleField.wrap);
    moreRow.appendChild(negativeField);
    moreRow.appendChild(cancelButton);
    dock.appendChild(moreRow);
    root.appendChild(dock);

    var menu = make('div', 'aic-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    root.appendChild(menu);

    var toast = make('div', 'aic-toast');
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    root.appendChild(toast);

    var fileInput = make('input', 'aic-file');
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif';
    fileInput.multiple = true;
    root.appendChild(fileInput);

    var importInput = make('input', 'aic-file');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    root.appendChild(importInput);

    var helpMask = make('div', 'aic-help-mask');
    helpMask.setAttribute('role', 'dialog');
    helpMask.setAttribute('aria-label', '画布快捷键与操作');
    var helpBox = make('div', 'aic-help');
    var helpHead = make('div', 'aic-help-head');
    helpHead.appendChild(make('div', 'aic-help-title', '画布快捷键与操作'));
    var helpClose = iconButton('close', '关闭帮助');
    helpHead.appendChild(helpClose);
    helpBox.appendChild(helpHead);
    helpBox.appendChild(make('div', 'aic-help-sub', '画布内容自动保存在浏览器本地；项目可导出为 JSON 文件或 PNG 快照，换设备后仍可导入。'));
    var helpGrid = make('div', 'aic-help-grid');
    var helpSections = [
      ['选择与编辑', [
        ['Shift + 点击', '加选 / 取消选择节点'],
        ['空白处拖动（选择工具）', '框选多个节点'],
        ['Ctrl / ⌘ + A', '全选所有节点'],
        ['Ctrl / ⌘ + D', '复制选中节点'],
        ['Ctrl / ⌘ + C / V', '复制 / 粘贴节点'],
        ['Delete / Backspace', '删除选中节点'],
        ['方向键 / Shift + 方向键', '微调 1px / 10px'],
        ['右键节点', '锁定、复制图片、重新生成']
      ]],
      ['画布导航', [
        ['空格 + 拖动 / 中键', '平移画布'],
        ['滚轮', '以鼠标位置缩放'],
        ['0', '恢复 100% 缩放'],
        ['1 / F', '适应视图'],
        ['?', '打开 / 关闭本帮助'],
        ['Esc', '取消连线、关闭菜单或取消选择']
      ]],
      ['生成与项目', [
        ['Ctrl / ⌘ + Enter', '按当前参数生成图片'],
        ['输出锚点 → 输入锚点', '把图片连为提示词的参考图'],
        ['项目 → 导出项目', '保存为 JSON 项目文件'],
        ['项目 → 导出画布图片', '保存整块画布的 PNG 快照'],
        ['项目 → 自动布局', '按类型重新排列全部节点']
      ]]
    ];
    helpSections.forEach(function (section) {
      helpGrid.appendChild(make('div', 'aic-help-section', section[0]));
      section[1].forEach(function (row) {
        var line = make('div', 'aic-help-row');
        line.appendChild(make('span', '', row[1]));
        line.appendChild(make('kbd', '', row[0]));
        helpGrid.appendChild(line);
      });
    });
    helpBox.appendChild(helpGrid);
    helpMask.appendChild(helpBox);
    root.appendChild(helpMask);

    var nodeElements = {};
    var edgeElements = {};

    function bind(target, type, handler, options) {
      target.addEventListener(type, handler, options || false);
      destroyHandlers.push({ target: target, type: type, handler: handler, options: options || false });
    }

    function notify(message, type, duration) {
      toast.textContent = message;
      toast.className = 'aic-toast' + (type ? ' ' + type : '');
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.hidden = true; }, duration || 3200);
    }

    function setStatus(message) {
      dockStatus.textContent = message;
    }

    function getNode(id) {
      for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i];
      return null;
    }

    function getEdge(id) {
      for (var i = 0; i < edges.length; i++) if (edges[i].id === id) return edges[i];
      return null;
    }

    function currentText() {
      for (var i = selectedIds.length - 1; i >= 0; i--) {
        var picked = getNode(selectedIds[i]);
        if (picked && picked.type === 'text') return picked;
      }
      var node = getNode(activeTextId);
      if (node && node.type === 'text') return node;
      node = getNode(selectedId);
      if (node && node.type === 'text') return node;
      for (var n = 0; n < nodes.length; n++) if (nodes[n].type === 'text') return nodes[n];
      return null;
    }

    function updateQuota() {
      var used = Number(pageData.used);
      var limit = Number(pageData.dailyLimit);
      if (!isFinite(used)) used = 0;
      if (!isFinite(limit)) limit = 0;
      quota.textContent = pageData.unlimited ? '今日已用 ' + used + ' 次 · 不限量' : '今日剩余 ' + Math.max(0, limit - used) + ' / ' + limit + ' 次';
    }

    function updateProjectMeta() {
      if (!projectMeta) return;
      var stamp = '';
      if (savedAt) {
        try {
          stamp = new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } catch (err) {
          stamp = '';
        }
      }
      projectMeta.textContent = dateText + ' · ' + nodes.length + ' 个节点' + (stamp ? ' · 已保存 ' + stamp : ' · 自动保存');
    }

    function updateUndoButtons() {
      undoButton.disabled = !undoStack.length || generating;
      redoButton.disabled = !redoStack.length || generating;
      undoButton.style.opacity = undoStack.length ? '1' : '.4';
      redoButton.style.opacity = redoStack.length ? '1' : '.4';
    }

    function serializeNodes() {
      return nodes.map(function (node) {
        var saved = Object.assign({}, node);
        // blob: / data: 预览地址不必写进 localStorage：保留 blobId，刷新后从 IndexedDB 恢复，
        // 避免大图 base64 占满 5MB 配额导致整个画布无法保存。
        if (saved.blobId && (/^blob:/.test(saved.url || '') || /^data:image\//.test(saved.url || ''))) saved.url = '';
        return saved;
      });
    }

    function persistNow() {
      if (destroyed) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          version: 2,
          nodes: serializeNodes(),
          edges: edges,
          viewport: viewport,
          prompt: promptInput.value,
          activeTextId: activeTextId,
          prefs: collectPrefs()
        }));
        savedAt = Date.now();
        updateProjectMeta();
        if (!serverSync.applying) scheduleServerSave();
      } catch (err) {
        notify('本地存储空间不足，本次更改可能无法在刷新后恢复', 'error', 5000);
      }
    }

    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persistNow, 350);
    }

    // ===== 服务端项目与协作（仅在 /ai-canvas 独立通道启用） =====
    var serverSync = {
      version: Number(CFG.projectVersion) || 0,
      timer: null,
      saving: false,
      applying: false,
      pointer: null,
      peerLayer: null,
      peersTimer: null
    };

    function setSaveState(text) {
      if (saveStateLabel) saveStateLabel.textContent = text || '';
    }

    function scheduleServerSave() {
      if (!SERVER || !SERVER.apiBase || !SERVER.projectId || !SERVER.canEdit) return;
      clearTimeout(serverSync.timer);
      serverSync.timer = setTimeout(pushServerState, 1200);
    }

    function pushServerState() {
      if (serverSync.saving || destroyed) return;
      if (!SERVER || !SERVER.apiBase || !SERVER.projectId || !SERVER.canEdit) return;
      serverSync.saving = true;
      setSaveState('保存中…');
      var headers = { 'Content-Type': 'application/json' };
      if (SERVER.csrfToken) headers['X-CSRF-Token'] = SERVER.csrfToken;
      fetch(SERVER.apiBase + '/projects/' + SERVER.projectId, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: headers,
        body: JSON.stringify({
          state: captureCurrent(),
          nodeCount: nodes.length,
          baseVersion: serverSync.version
        })
      }).then(function (resp) {
        return resp.json().then(function (json) { return { status: resp.status, json: json }; });
      }).then(function (result) {
        serverSync.saving = false;
        if (result.status === 409) {
          var data = result.json && result.json.data;
          if (data && data.state) {
            serverSync.version = data.version;
            applyServerState(data.state);
            notify('画布已被 ' + (data.updatedBy || '其他成员') + ' 更新，已同步为最新版本', 'info', 5000);
          }
          return;
        }
        if (result.json && result.json.success) {
          serverSync.version = result.json.data.version;
          setSaveState('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        } else {
          setSaveState('保存失败，稍后重试');
        }
      }).catch(function () {
        serverSync.saving = false;
        setSaveState('网络异常，未保存');
      });
    }

    function applyServerState(state) {
      serverSync.applying = true;
      try {
        restoreSnapshot(state);
      } finally {
        serverSync.applying = false;
      }
    }

    function pollVersion() {
      if (!SERVER || !SERVER.apiBase || !SERVER.projectId || destroyed) return;
      fetch(SERVER.apiBase + '/projects/' + SERVER.projectId + '/version', { credentials: 'same-origin' })
        .then(function (resp) { return resp.ok ? resp.json() : null; })
        .then(function (json) {
          if (!json || !json.success || destroyed) return;
          var remote = json.data.version;
          if (remote && remote > serverSync.version && !serverSync.saving) {
            serverSync.version = remote;
            fetch(SERVER.apiBase + '/projects/' + SERVER.projectId + '/state?since=' + (remote - 1),
              { credentials: 'same-origin' })
              .then(function (resp) { return resp.ok ? resp.json() : null; })
              .then(function (stateJson) {
                if (!stateJson || !stateJson.success) return;
                applyServerState(stateJson.data.state || {});
                notify('已同步 ' + (json.data.updatedBy || '其他成员') + ' 的最新改动', 'info', 4000);
              });
          }
        })
        .catch(function () { /* 轮询失败静默重试 */ });
    }

    function renderPeers(list) {
      if (!serverSync.peerLayer) return;
      var seen = {};
      list.forEach(function (peer) {
        seen[peer.userId] = true;
        var el = serverSync.peerLayer.querySelector('[data-uid="' + peer.userId + '"]');
        if (!el) {
          el = make('div', 'aic-peer');
          el.setAttribute('data-uid', String(peer.userId));
          el.appendChild(make('span', 'aic-peer-dot'));
          el.appendChild(make('span', '', peer.name || ('#' + peer.userId)));
          serverSync.peerLayer.appendChild(el);
        }
        var left = Number(peer.x) * viewport.scale + viewport.x;
        var top = Number(peer.y) * viewport.scale + viewport.y;
        el.style.transform = 'translate(' + left + 'px,' + top + 'px)';
      });
      Array.prototype.forEach.call(serverSync.peerLayer.children, function (el) {
        if (!seen[el.getAttribute('data-uid')]) el.remove();
      });
    }

    function pollPeers() {
      if (!SERVER || !SERVER.apiBase || !SERVER.projectId || destroyed) return;
      fetch(SERVER.apiBase + '/projects/' + SERVER.projectId + '/presence', { credentials: 'same-origin' })
        .then(function (resp) { return resp.ok ? resp.json() : null; })
        .then(function (json) {
          if (json && json.success) renderPeers(json.data || []);
        })
        .catch(function () { /* 静默 */ });
    }

    function pushPresence() {
      if (!SERVER || !SERVER.apiBase || !SERVER.projectId || !SERVER.canEdit) return;
      var pointer = serverSync.pointer;
      if (!pointer) return;
      var headers = { 'Content-Type': 'application/json' };
      if (SERVER.csrfToken) headers['X-CSRF-Token'] = SERVER.csrfToken;
      fetch(SERVER.apiBase + '/projects/' + SERVER.projectId + '/presence', {
        method: 'POST',
        credentials: 'same-origin',
        headers: headers,
        body: JSON.stringify({ x: pointer.x, y: pointer.y, selected: selectedIds.slice(0, 20) })
      }).catch(function () { /* 静默 */ });
    }

    function startCollab() {
      if (!SERVER || !SERVER.apiBase || !SERVER.projectId) return;
      serverSync.peerLayer = make('div', 'aic-peers');
      viewportEl.appendChild(serverSync.peerLayer);
      bind(viewportEl, 'pointermove', function (event) {
        var rect = root.getBoundingClientRect();
        serverSync.pointer = {
          x: (event.clientX - rect.left - viewport.x) / viewport.scale,
          y: (event.clientY - rect.top - viewport.y) / viewport.scale
        };
      });
      setInterval(pollVersion, 3000);
      setInterval(pollPeers, 3000);
      setInterval(pushPresence, 4000);
      setSaveState('已连接协作');
    }

    function checkpoint() {
      undoStack.push(cloneState({ nodes: nodes, edges: edges, viewport: viewport, prompt: promptInput.value, activeTextId: activeTextId, prefs: collectPrefs() }));
      if (undoStack.length > 45) undoStack.shift();
      redoStack = [];
      updateUndoButtons();
    }

    function captureCurrent() {
      return cloneState({ nodes: nodes, edges: edges, viewport: viewport, prompt: promptInput.value, activeTextId: activeTextId, prefs: collectPrefs() });
    }

    function restoreSnapshot(snapshot) {
      var restored = sanitizeState(snapshot);
      nodes = restored.nodes;
      edges = restored.edges;
      viewport = restored.viewport || viewport;
      activeTextId = restored.activeTextId;
      promptInput.value = restored.prompt;
      selectedIds = [];
      selectedId = '';
      selectedEdgeId = '';
      generationNodeIds = [];
      fileBlobs = {};
      blobLoads = {};
      blobWrites = {};
      clearGuides();
      if (marquee) {
        marqueeEl.classList.remove('show');
        marquee = null;
      }
      applyPrefs(restored.prefs);
      renderAll();
      syncPrompt();
      scheduleSave();
    }

    function undo() {
      if (!undoStack.length || generating) return;
      redoStack.push(captureCurrent());
      restoreSnapshot(undoStack.pop());
      setStatus('已撤销上一步操作');
      updateUndoButtons();
    }

    function redo() {
      if (!redoStack.length || generating) return;
      undoStack.push(captureCurrent());
      restoreSnapshot(redoStack.pop());
      setStatus('已重做');
      updateUndoButtons();
    }

    function setActiveText(node) {
      if (!node || node.type !== 'text') return;
      activeTextId = node.id;
      promptInput.value = node.text;
      updatePromptCount();
      renderSelection();
      updateDockStatus();
      scheduleSave();
    }

    function updatePromptCount() {
      promptCount.textContent = promptInput.value.length + ' / 12000';
    }

    function syncPrompt() {
      updatePromptCount();
      var text = currentText();
      if (text) {
        text.text = promptInput.value;
        var editor = nodeElements[text.id] && nodeElements[text.id].querySelector('.aic-text-edit');
        if (editor && document.activeElement !== editor) editor.value = text.text;
        var count = nodeElements[text.id] && nodeElements[text.id].querySelector('.aic-text-count');
        if (count) count.textContent = text.text.length + ' 字';
      } else if (activeTextId && !getNode(activeTextId)) {
        activeTextId = '';
      }
      updateDockStatus();
      scheduleSave();
    }

    function updateDockStatus() {
      if (generating) return;
      var refs = incomingReferences(currentText());
      setStatus(refs.length ? '已连接 ' + refs.length + ' 张参考图 · 使用最新一张生成' : '就绪 · Ctrl / Command + Enter 生成');
    }

    function collectPrefs() {
      return {
        provider: providerField.input.value,
        model: modelField.input.value,
        size: sizeField.input.value,
        ratio: ratioField.input.value,
        quality: qualityField.input.value,
        n: Number(countField.input.value) || 1,
        seed: seedInput.value,
        style: styleField.input.value,
        negativePrompt: negativeInput.value
      };
    }

    function applyPrefs(saved) {
      saved = saved || {};
      if (providers.some(function (p) { return p.provider_key === saved.provider; })) providerField.input.value = saved.provider;
      renderModels();
      if (modelField.input.value !== saved.model && Array.prototype.some.call(modelField.input.options, function (o) { return o.value === saved.model; })) {
        modelField.input.value = saved.model;
      }
      if (Array.prototype.some.call(sizeField.input.options, function (o) { return o.value === saved.size; })) sizeField.input.value = saved.size;
      else if (Array.prototype.some.call(sizeField.input.options, function (o) { return o.value === '1024x1024'; })) sizeField.input.value = '1024x1024';

      // 比例/画质：优先用新字段；只有旧 size 时按预设表反查一次
      var restoredRatio = '';
      var restoredQuality = '';
      if (saved.ratio && Array.prototype.some.call(ratioField.input.options, function (o) { return o.value === saved.ratio; })) {
        restoredRatio = saved.ratio;
      }
      if (saved.quality && Array.prototype.some.call(qualityField.input.options, function (o) { return o.value === saved.quality; })) {
        restoredQuality = saved.quality;
      }
      if ((!restoredRatio || !restoredQuality) && saved.size) {
        var presets = Array.isArray(pageData.sizePresets) ? pageData.sizePresets : [];
        for (var i = 0; i < presets.length; i++) {
          if (presets[i] && presets[i].value === saved.size && presets[i].ratio) {
            if (!restoredRatio) restoredRatio = presets[i].ratio;
            if (!restoredQuality && presets[i].quality) restoredQuality = String(presets[i].quality).toLowerCase();
            break;
          }
        }
      }
      if (restoredRatio) ratioField.input.value = restoredRatio;
      if (restoredQuality) qualityField.input.value = restoredQuality;
      if (customDim) customDim.hidden = qualityField.input.value !== '__custom__';
      syncLegacySize();

      if ([1, 2, 3, 4].indexOf(Number(saved.n)) !== -1) countField.input.value = String(saved.n);
      seedInput.value = safeText(saved.seed, '', 30);
      if (Array.prototype.some.call(styleField.input.options, function (o) { return o.value === saved.style; })) styleField.input.value = saved.style;
      negativeInput.value = safeText(saved.negativePrompt, '', 4000);
      updateProviderCapabilities();
    }

    function renderModels() {
      var provider = providers.filter(function (p) { return p.provider_key === providerField.input.value; })[0] || providers[0];
      var previous = modelField.input.value;
      modelField.input.textContent = '';
      var models = provider ? (provider.models.length ? provider.models.slice() : (provider.default_model ? [provider.default_model] : [])) : [];
      if (!models.length) models.push('');
      models.forEach(function (model) {
        var option = make('option', '', model || '默认模型');
        option.value = model;
        modelField.input.appendChild(option);
      });
      var defaultModel = provider ? provider.default_model : '';
      if (models.indexOf(previous) !== -1) modelField.input.value = previous;
      else if (defaultModel && models.indexOf(defaultModel) !== -1) modelField.input.value = defaultModel;
      else modelField.input.value = models[0];
      updateProviderCapabilities();
    }

    function syncProviderModels(providerKey, models, defaultModel) {
      var provider = providers.filter(function (p) { return p.provider_key === providerKey; })[0];
      if (!provider) return;
      provider.models = Array.isArray(models) ? models.filter(function (model) {
        return typeof model === 'string' && model.length <= 300;
      }).slice(0, 200) : [];
      provider.default_model = typeof defaultModel === 'string' ? defaultModel.slice(0, 300) : '';
      if (providerField.input.value === providerKey) renderModels();
      updateProviderCapabilities();
    }

    function updateProviderCapabilities() {
      var provider = providers.filter(function (p) { return p.provider_key === providerField.input.value; })[0] || providers[0];
      countField.input.disabled = !provider || !provider.supports_n;
      if (countField.input.disabled) countField.input.value = '1';
      negativeField.style.display = provider && provider.supports_negative ? '' : 'none';
      generateButton.disabled = !provider || !window.aiImageGenerate;
      if (!provider) generateButton.textContent = '暂无服务商';
      else if (!window.aiImageGenerate) generateButton.textContent = '等待生图服务';
      else if (!generating) generateButton.textContent = '生成图片';
    }

    function applyTransform() {
      world.style.transform = 'translate(' + viewport.x + 'px,' + viewport.y + 'px) scale(' + viewport.scale + ')';
      viewportEl.style.setProperty('--aic-dot-x', ((viewport.x % 24 + 24) % 24) + 'px');
      viewportEl.style.setProperty('--aic-dot-y', ((viewport.y % 24 + 24) % 24) + 'px');
      zoomValue.textContent = Math.round(viewport.scale * 100) + '%';
      scheduleMinimap();
    }

    function screenToWorld(clientX, clientY) {
      var rect = viewportEl.getBoundingClientRect();
      return { x: (clientX - rect.left - viewport.x) / viewport.scale, y: (clientY - rect.top - viewport.y) / viewport.scale };
    }

    function centerWorld() {
      var rect = viewportEl.getBoundingClientRect();
      return { x: (rect.width / 2 - viewport.x) / viewport.scale, y: (rect.height / 2 - viewport.y) / viewport.scale };
    }

    function zoomAt(factor, clientX, clientY) {
      var rect = viewportEl.getBoundingClientRect();
      var px = typeof clientX === 'number' ? clientX - rect.left : rect.width / 2;
      var py = typeof clientY === 'number' ? clientY - rect.top : rect.height / 2;
      var wx = (px - viewport.x) / viewport.scale;
      var wy = (py - viewport.y) / viewport.scale;
      var scale = clamp(viewport.scale * factor, 0.2, 2.5);
      viewport.x = px - wx * scale;
      viewport.y = py - wy * scale;
      viewport.scale = scale;
      applyTransform();
      scheduleSave();
    }

    function allBounds() {
      if (!nodes.length) return null;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      nodes.forEach(function (node) {
        var size = nodeSize(node);
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + size.width);
        maxY = Math.max(maxY, node.y + size.height);
      });
      return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY };
    }

    function selectionBounds() {
      var list = selectedIds.map(getNode).filter(Boolean);
      if (!list.length) return null;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      list.forEach(function (node) {
        var size = nodeSize(node);
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + size.width);
        maxY = Math.max(maxY, node.y + size.height);
      });
      return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY };
    }

    function fitBounds(bounds, maxScale) {
      if (!bounds) return;
      var rect = viewportEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var width = Math.max(1, bounds.maxX - bounds.minX);
      var height = Math.max(1, bounds.maxY - bounds.minY);
      var scale = clamp(Math.min((rect.width - 130) / width, (rect.height - 220) / height), 0.2, maxScale || 1.35);
      viewport.scale = scale;
      viewport.x = (rect.width - width * scale) / 2 - bounds.minX * scale;
      viewport.y = Math.max(80, (rect.height - 135 - height * scale) / 2) - bounds.minY * scale;
      applyTransform();
      scheduleSave();
    }

    function fitView() {
      if (!nodes.length) {
        viewport = { x: 70, y: 70, scale: 1 };
        applyTransform();
        return;
      }
      fitBounds(allBounds(), 1.35);
      fitWhenVisible = false;
    }

    function zoomToSelection() {
      var bounds = selectionBounds();
      if (!bounds) {
        notify('请先选择要放大的节点', 'info');
        return;
      }
      fitBounds(bounds, 1.6);
      setStatus('已缩放到选中节点');
    }

    function resetZoom() {
      if (Math.abs(viewport.scale - 1) < 0.001) return;
      zoomAt(1 / viewport.scale);
    }

    function nodeSize(node) {
      return { width: NODE_WIDTH[node.type], height: NODE_HEIGHT[node.type] };
    }

    function nodeBounds(node) {
      var size = nodeSize(node);
      return { x: node.x, y: node.y, width: size.width, height: size.height };
    }

    function updateNodePositions() {
      nodes.forEach(function (node) {
        var el = nodeElements[node.id];
        if (!el) return;
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
      });
      drawEdges();
      scheduleSave();
      scheduleMinimap();
    }

    function alignSelection(mode) {
      var list = selectedIds.map(getNode).filter(Boolean);
      if (list.length < 2 || generating) return;
      var bounds = selectionBounds();
      if (!bounds) return;
      checkpoint();
      list.forEach(function (node) {
        var size = nodeSize(node);
        if (mode === 'left') node.x = bounds.minX;
        else if (mode === 'hcenter') node.x = Math.round((bounds.minX + bounds.maxX) / 2 - size.width / 2);
        else if (mode === 'right') node.x = bounds.maxX - size.width;
        else if (mode === 'top') node.y = bounds.minY;
        else if (mode === 'vcenter') node.y = Math.round((bounds.minY + bounds.maxY) / 2 - size.height / 2);
        else if (mode === 'bottom') node.y = bounds.maxY - size.height;
      });
      updateNodePositions();
      setStatus('已对齐 ' + list.length + ' 个节点');
    }

    function distributeSelection(axis) {
      var list = selectedIds.map(getNode).filter(Boolean);
      if (list.length < 3 || generating) return;
      checkpoint();
      var horizontal = axis !== 'v';
      list.sort(function (a, b) {
        var aSize = nodeSize(a);
        var bSize = nodeSize(b);
        return horizontal ? (a.x + aSize.width / 2) - (b.x + bSize.width / 2) : (a.y + aSize.height / 2) - (b.y + bSize.height / 2);
      });
      var first = list[0];
      var last = list[list.length - 1];
      var firstSize = nodeSize(first);
      var lastSize = nodeSize(last);
      var start = horizontal ? first.x + firstSize.width / 2 : first.y + firstSize.height / 2;
      var end = horizontal ? last.x + lastSize.width / 2 : last.y + lastSize.height / 2;
      var step = (end - start) / (list.length - 1);
      list.forEach(function (node, index) {
        if (index === 0 || index === list.length - 1) return;
        var size = nodeSize(node);
        if (horizontal) node.x = Math.round(start + step * index - size.width / 2);
        else node.y = Math.round(start + step * index - size.height / 2);
      });
      updateNodePositions();
      setStatus('已等距分布 ' + list.length + ' 个节点');
    }

    function arrangeSelection() {
      var list = selectedIds.map(getNode).filter(Boolean);
      if (list.length < 2 || generating) return;
      var bounds = selectionBounds();
      if (!bounds) return;
      checkpoint();
      var cellWidth = 0, cellHeight = 0;
      list.forEach(function (node) {
        var size = nodeSize(node);
        cellWidth = Math.max(cellWidth, size.width);
        cellHeight = Math.max(cellHeight, size.height);
      });
      cellWidth += 28;
      cellHeight += 24;
      var columns = Math.min(4, Math.ceil(Math.sqrt(list.length)));
      list.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
      list.forEach(function (node, index) {
        node.x = Math.round(bounds.minX + (index % columns) * cellWidth);
        node.y = Math.round(bounds.minY + Math.floor(index / columns) * cellHeight);
      });
      updateNodePositions();
      setStatus('已整理为 ' + columns + ' 列网格');
    }

    function autoLayout() {
      if (generating) return;
      if (nodes.length < 2) {
        notify('至少需要两个节点才能自动布局', 'info');
        return;
      }
      checkpoint();
      var columns = { text: 140, upload: 540, image: 900 };
      ['text', 'upload', 'image'].forEach(function (type) {
        var list = nodes.filter(function (node) { return node.type === type; }).sort(function (a, b) { return a.y - b.y || a.x - b.x; });
        var y = 170;
        list.forEach(function (node) {
          node.x = columns[type];
          node.y = y;
          y += nodeSize(node).height + 28;
        });
      });
      selectedIds = [];
      selectedId = '';
      updateNodePositions();
      renderSelection();
      updateSelectionBar();
      fitView();
      setStatus('已按类型自动布局');
    }

    function snapDrag(primary, nextX, nextY, moving) {
      var result = { x: nextX, y: nextY, v: null, h: null };
      if (!snapEnabled) return result;
      var size = nodeSize(primary);
      var threshold = SNAP_THRESHOLD / viewport.scale;
      var xValues = [nextX, nextX + size.width / 2, nextX + size.width];
      var yValues = [nextY, nextY + size.height / 2, nextY + size.height];
      var bestX = null;
      var bestY = null;
      nodes.forEach(function (other) {
        if (moving[other.id]) return;
        var otherSize = nodeSize(other);
        var otherX = [other.x, other.x + otherSize.width / 2, other.x + otherSize.width];
        var otherY = [other.y, other.y + otherSize.height / 2, other.y + otherSize.height];
        xValues.forEach(function (value) {
          otherX.forEach(function (target) {
            var diff = target - value;
            if (Math.abs(diff) <= threshold && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) bestX = { diff: diff, line: target };
          });
        });
        yValues.forEach(function (value) {
          otherY.forEach(function (target) {
            var diff = target - value;
            if (Math.abs(diff) <= threshold && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) bestY = { diff: diff, line: target };
          });
        });
      });
      if (bestX) {
        result.x = nextX + bestX.diff;
        result.v = bestX.line;
      } else {
        result.x = Math.round(nextX / SNAP_SIZE) * SNAP_SIZE;
      }
      if (bestY) {
        result.y = nextY + bestY.diff;
        result.h = bestY.line;
      } else {
        result.y = Math.round(nextY / SNAP_SIZE) * SNAP_SIZE;
      }
      return result;
    }

    function clearGuides() {
      while (guideGroup.firstChild) guideGroup.removeChild(guideGroup.firstChild);
    }

    function drawGuides(vertical, horizontal) {
      clearGuides();
      if (!snapEnabled || (vertical === null && horizontal === null)) return;
      var rect = viewportEl.getBoundingClientRect();
      var x0 = (-viewport.x) / viewport.scale;
      var y0 = (-viewport.y) / viewport.scale;
      var x1 = x0 + rect.width / viewport.scale;
      var y1 = y0 + rect.height / viewport.scale;
      function addLine(x1v, y1v, x2v, y2v) {
        var line = document.createElementNS(svgNs, 'line');
        line.setAttribute('class', 'aic-guide');
        line.setAttribute('x1', x1v);
        line.setAttribute('y1', y1v);
        line.setAttribute('x2', x2v);
        line.setAttribute('y2', y2v);
        guideGroup.appendChild(line);
      }
      if (vertical !== null) addLine(vertical, y0, vertical, y1);
      if (horizontal !== null) addLine(x0, horizontal, x1, horizontal);
    }

    function beginMarquee(event) {
      marquee = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        base: event.shiftKey ? selectedIds.slice() : [],
        moved: false
      };
      selectedEdgeId = '';
      if (!event.shiftKey) {
        applySelection([]);
        drawEdges();
      }
      marqueeEl.style.left = '0px';
      marqueeEl.style.top = '0px';
      marqueeEl.style.width = '0px';
      marqueeEl.style.height = '0px';
      marqueeEl.classList.remove('show');
      try { viewportEl.setPointerCapture(event.pointerId); } catch (err) {
        // 合成事件或旧浏览器可能不支持指针捕获。
      }
    }

    function updateMarquee(event) {
      if (!marquee) return;
      var dx = event.clientX - marquee.startClientX;
      var dy = event.clientY - marquee.startClientY;
      if (!marquee.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      marquee.moved = true;
      var left = Math.min(marquee.startClientX, event.clientX);
      var top = Math.min(marquee.startClientY, event.clientY);
      var right = Math.max(marquee.startClientX, event.clientX);
      var bottom = Math.max(marquee.startClientY, event.clientY);
      var viewRect = viewportEl.getBoundingClientRect();
      marqueeEl.style.left = (left - viewRect.left) + 'px';
      marqueeEl.style.top = (top - viewRect.top) + 'px';
      marqueeEl.style.width = Math.max(0, right - left) + 'px';
      marqueeEl.style.height = Math.max(0, bottom - top) + 'px';
      marqueeEl.classList.add('show');
      var start = screenToWorld(left, top);
      var end = screenToWorld(right, bottom);
      var hits = nodes.filter(function (node) {
        var bounds = nodeBounds(node);
        return bounds.x < end.x && bounds.x + bounds.width > start.x && bounds.y < end.y && bounds.y + bounds.height > start.y;
      }).map(function (node) { return node.id; });
      applySelection(marquee.base.concat(hits));
    }

    function endMarquee() {
      if (!marquee) return;
      marqueeEl.classList.remove('show');
      marquee = null;
    }

    function scheduleMinimap() {
      if (!minimapVisible || destroyed || minimapRaf) return;
      minimapRaf = requestAnimationFrame(function () {
        minimapRaf = 0;
        drawMinimap();
      });
    }

    function drawMinimap() {
      if (!minimapVisible || destroyed || !miniCanvas) return;
      var rect = miniCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var pixelWidth = Math.round(MINIMAP_WIDTH * dpr);
      var pixelHeight = Math.round(MINIMAP_HEIGHT * dpr);
      if (miniCanvas.width !== pixelWidth) miniCanvas.width = pixelWidth;
      if (miniCanvas.height !== pixelHeight) miniCanvas.height = pixelHeight;
      var ctx = miniCanvas.getContext('2d');
      if (!ctx) return;
      var dark = theme !== 'light';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
      ctx.fillStyle = dark ? '#14161b' : '#f7f8fb';
      ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
      var bounds = allBounds();
      miniZoomLabel.textContent = Math.round(viewport.scale * 100) + '%';
      if (!bounds) {
        miniView = null;
        ctx.fillStyle = dark ? '#969caa' : '#747b8e';
        ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('空画布', MINIMAP_WIDTH / 2, MINIMAP_HEIGHT / 2);
        return;
      }
      var pad = 22;
      var worldWidth = Math.max(1, bounds.maxX - bounds.minX + pad * 2);
      var worldHeight = Math.max(1, bounds.maxY - bounds.minY + pad * 2);
      var scale = Math.min(MINIMAP_WIDTH / worldWidth, MINIMAP_HEIGHT / worldHeight);
      var offsetX = (MINIMAP_WIDTH - (bounds.maxX - bounds.minX) * scale) / 2 - bounds.minX * scale;
      var offsetY = (MINIMAP_HEIGHT - (bounds.maxY - bounds.minY) * scale) / 2 - bounds.minY * scale;
      miniView = { scale: scale, offsetX: offsetX, offsetY: offsetY };
      nodes.forEach(function (node) {
        var size = nodeSize(node);
        var x = offsetX + node.x * scale;
        var y = offsetY + node.y * scale;
        var width = Math.max(2, size.width * scale);
        var height = Math.max(2, size.height * scale);
        ctx.globalAlpha = node.locked ? 0.55 : 0.9;
        ctx.fillStyle = isSelected(node.id) ? (dark ? '#a992ff' : '#7457d9') :
          node.type === 'text' ? (dark ? '#6d5bd0' : '#8b78e6') :
            node.type === 'upload' ? (dark ? '#4a9fd8' : '#5aa7d6') : (dark ? '#3fa87d' : '#4caf8a');
        ctx.fillRect(x, y, width, height);
      });
      ctx.globalAlpha = 1;
      var viewX = offsetX + (-viewport.x / viewport.scale) * scale;
      var viewY = offsetY + (-viewport.y / viewport.scale) * scale;
      var viewWidth = (viewportEl.clientWidth / viewport.scale) * scale;
      var viewHeight = (viewportEl.clientHeight / viewport.scale) * scale;
      ctx.strokeStyle = dark ? '#f1f2f5' : '#242632';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.75;
      ctx.strokeRect(viewX, viewY, viewWidth, viewHeight);
      ctx.globalAlpha = 1;
    }

    function minimapJumpTo(event) {
      drawMinimap();
      if (!miniView) return;
      var rect = miniCanvas.getBoundingClientRect();
      var worldX = (event.clientX - rect.left - miniView.offsetX) / miniView.scale;
      var worldY = (event.clientY - rect.top - miniView.offsetY) / miniView.scale;
      viewport.x = viewportEl.clientWidth / 2 - worldX * viewport.scale;
      viewport.y = viewportEl.clientHeight / 2 - worldY * viewport.scale;
      applyTransform();
      scheduleSave();
    }

    function downloadBlob(blob, filename) {
      var url = URL.createObjectURL(blob);
      var anchor = make('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (err) {
          // 浏览器可能已自动回收。
        }
      }, 4000);
    }

    function fileStamp() {
      return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    }

    function blobToDataUrl(blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(typeof reader.result === 'string' ? reader.result : ''); };
        reader.onerror = function () { reject(reader.error || new Error('图片读取失败')); };
        reader.readAsDataURL(blob);
      });
    }

    async function serializeProject() {
      var list = [];
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var copy = Object.assign({}, node);
        if (copy.blobId && (!copy.url || /^(data:|blob:)/.test(copy.url))) {
          try {
            var record = await getBlob(copy.blobId);
            if (record && record.blob) copy.url = await blobToDataUrl(record.blob);
          } catch (err) {
            copy.url = '';
          }
        }
        list.push(copy);
      }
      return {
        app: 'ai-image-canvas',
        version: 2,
        exportedAt: new Date().toISOString(),
        nodes: list,
        edges: edges,
        viewport: viewport,
        prompt: promptInput.value,
        prefs: collectPrefs()
      };
    }

    async function exportProject() {
      if (!nodes.length) {
        notify('画布是空的，没有可导出的节点', 'info');
        return;
      }
      try {
        var payload = await serializeProject();
        var name = 'ai-canvas-' + fileStamp() + '.json';
        downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), name);
        notify('项目已导出：' + name, 'success', 4200);
      } catch (err) {
        notify('导出项目失败：' + errorMessage(err), 'error', 5000);
      }
    }

    async function importProjectFile(file) {
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) {
        notify('项目文件不能超过 25MB', 'error');
        return;
      }
      try {
        var text = await file.text();
        var raw = JSON.parse(text);
        var imported = sanitizeState(raw);
        if (!imported.nodes.length) throw new Error('文件里没有可用的画布节点');
        if (nodes.length && !window.confirm('导入将替换当前画布（可撤销），继续吗？')) return;
        checkpoint();
        for (var i = 0; i < imported.nodes.length; i++) {
          var node = imported.nodes[i];
          if (/^data:image\//.test(node.url) && !node.blobId) {
            try {
              var response = await fetch(node.url);
              var blob = await response.blob();
              if (blob && blob.size <= MAX_FILE_SIZE && /^image\/(jpeg|png|webp)$/i.test(blob.type || '')) {
                var blobId = uid('aic-upload');
                var stored = await putBlobSafe(blobId, blob);
                if (stored) {
                  node.blobId = blobId;
                  node.mime = blob.type;
                  node.url = URL.createObjectURL(blob);
                  objectUrls.push(node.url);
                }
              }
            } catch (err) {
              // 图片写入 IndexedDB 失败时保留 data URL，至少本次会话可用。
            }
          } else if (/^blob:/.test(node.url)) {
            node.url = '';
          }
        }
        nodes = imported.nodes;
        edges = imported.edges;
        viewport = imported.viewport || viewport;
        activeTextId = imported.activeTextId || '';
        promptInput.value = imported.prompt || '';
        selectedIds = [];
        selectedId = '';
        selectedEdgeId = '';
        fileBlobs = {};
        blobLoads = {};
        blobWrites = {};
        applyPrefs(imported.prefs);
        renderAll();
        updatePromptCount();
        persistNow();
        notify('已导入 ' + nodes.length + ' 个节点', 'success', 4000);
        setStatus('项目导入完成');
      } catch (err) {
        notify('导入失败：' + errorMessage(err), 'error', 6000);
      }
    }

    function clearCanvas() {
      if (generating || !nodes.length) return;
      if (!window.confirm('清空画布上的所有节点？（可撤销）')) return;
      checkpoint();
      nodes = [];
      edges = [];
      activeTextId = '';
      selectedIds = [];
      selectedId = '';
      selectedEdgeId = '';
      promptInput.value = '';
      updatePromptCount();
      renderAll();
      persistNow();
      setStatus('画布已清空，可撤销');
    }

    function selectAllNodes() {
      if (!nodes.length) return;
      setSelection(nodes.map(function (node) { return node.id; }));
      setStatus('已全选 ' + nodes.length + ' 个节点');
    }

    function copyText(value, message) {
      if (!value) {
        notify('没有可复制的内容', 'info');
        return;
      }
      function done() { notify(message || '已复制到剪贴板', 'success', 2000); }
      function fallback() {
        var area = make('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try {
          document.execCommand('copy');
          done();
        } catch (err) {
          notify('复制失败，请手动选择文本', 'error');
        }
        area.remove();
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(done, fallback);
      } else {
        fallback();
      }
    }

    async function copyImage(node) {
      try {
        if (!node || !node.url) throw new Error('该节点还没有图片');
        if (!navigator.clipboard || typeof window.ClipboardItem !== 'function') throw new Error('当前浏览器不支持复制图片');
        var response = await fetch(node.url);
        if (!response.ok) throw new Error('图片读取失败（HTTP ' + response.status + '）');
        var blob = await response.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        notify('图片已复制到剪贴板', 'success', 2400);
      } catch (err) {
        notify('复制图片失败：' + errorMessage(err), 'error', 5000);
      }
    }

    function toggleLock(id) {
      var node = getNode(id);
      if (!node || generating) return;
      checkpoint();
      node.locked = !node.locked;
      renderNode(node);
      scheduleSave();
      setStatus(node.locked ? '已锁定节点位置' : '已解锁节点位置');
    }

    function regenerate(node) {
      if (!node || generating) return;
      if (!node.prompt) {
        notify('该节点没有可复用的提示词', 'info');
        return;
      }
      promptInput.value = node.prompt;
      syncPrompt();
      if (node.provider && providers.some(function (provider) { return provider.provider_key === node.provider; })) {
        providerField.input.value = node.provider;
        renderModels();
      }
      if (node.model && Array.prototype.some.call(modelField.input.options, function (option) { return option.value === node.model; })) {
        modelField.input.value = node.model;
      }
      if (node.size && Array.prototype.some.call(sizeField.input.options, function (option) { return option.value === node.size; })) {
        sizeField.input.value = node.size;
      }
      updateProviderCapabilities();
      setStatus('已载入该节点参数，正在重新生成…');
      generate();
    }

    function openHelp() {
      helpMask.classList.add('show');
      helpClose.focus({ preventScroll: true });
    }

    function closeHelp() {
      helpMask.classList.remove('show');
    }

    function isExportableImageUrl(url) {
      if (!url) return false;
      if (/^data:image\//.test(url)) return true;
      try {
        return new URL(url, window.location.href).origin === window.location.origin;
      } catch (err) {
        return false;
      }
    }

    function loadExportImage(url) {
      return new Promise(function (resolve) {
        if (!isExportableImageUrl(url)) {
          resolve(null);
          return;
        }
        var image = new Image();
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(null);
        }, 8000);
        image.onload = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(image);
        };
        image.onerror = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        };
        image.src = url;
      });
    }

    function roundRectPath(ctx, x, y, width, height, radius) {
      var r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + width, y, x + width, y + height, r);
      ctx.arcTo(x + width, y + height, x, y + height, r);
      ctx.arcTo(x, y + height, x, y, r);
      ctx.arcTo(x, y, x + width, y, r);
      ctx.closePath();
    }

    function drawImageCover(ctx, image, x, y, width, height) {
      var imageWidth = image.naturalWidth || image.width;
      var imageHeight = image.naturalHeight || image.height;
      if (!imageWidth || !imageHeight) return;
      var ratio = Math.max(width / imageWidth, height / imageHeight);
      var sourceWidth = width / ratio;
      var sourceHeight = height / ratio;
      ctx.drawImage(image, (imageWidth - sourceWidth) / 2, (imageHeight - sourceHeight) / 2, sourceWidth, sourceHeight, x, y, width, height);
    }

    function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines, font, color) {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      var paragraphs = String(text || '').split(/\r?\n/);
      var lines = [];
      paragraphs.forEach(function (paragraph) {
        if (!paragraph) {
          lines.push('');
          return;
        }
        var current = '';
        for (var i = 0; i < paragraph.length; i++) {
          var next = current + paragraph[i];
          if (ctx.measureText(next).width > maxWidth && current) {
            lines.push(current);
            current = paragraph[i];
          } else {
            current = next;
          }
        }
        if (current) lines.push(current);
      });
      if (!lines.length) lines.push('');
      if (lines.length > maxLines) {
        lines = lines.slice(0, maxLines);
        lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(0, lines[maxLines - 1].length - 1)) + '…';
      }
      lines.forEach(function (line, index) { ctx.fillText(line, x, y + index * lineHeight); });
      return y + lines.length * lineHeight;
    }

    function drawExportNode(ctx, node, image, palette) {
      var size = nodeSize(node);
      var x = node.x;
      var y = node.y;
      ctx.save();
      roundRectPath(ctx, x, y, size.width, size.height, 13);
      ctx.fillStyle = palette.panel;
      ctx.fill();
      ctx.strokeStyle = isSelected(node.id) ? palette.accent : palette.border;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 1, y + 44);
      ctx.lineTo(x + size.width - 1, y + 44);
      ctx.strokeStyle = palette.border;
      ctx.stroke();
      roundRectPath(ctx, x + 12, y + 10, 25, 25, 7);
      ctx.fillStyle = palette.accent;
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 11px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.type === 'text' ? 'T' : node.type === 'upload' ? 'R' : 'I', x + 24.5, y + 23);
      ctx.textAlign = 'left';
      ctx.fillStyle = palette.text;
      ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.type === 'text' ? 'Text 提示词' : node.type === 'upload' ? '参考图片' : 'Image 结果', x + 46, y + 23);
      ctx.textAlign = 'right';
      ctx.fillStyle = palette.muted;
      ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
      var meta = node.type === 'text' ? 'PROMPT' : node.type === 'upload' ? 'JPG / PNG / WebP' : (node.size || 'IMAGE');
      ctx.fillText(meta, x + size.width - 14, y + 23);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      var bodyX = x + 11;
      var bodyY = y + 55;
      var bodyWidth = size.width - 22;
      if (node.type === 'text') {
        drawWrappedText(ctx, node.text || '（空提示词）', bodyX, bodyY + 14, bodyWidth, 19, 5,
          '12px "Segoe UI", "Microsoft YaHei", sans-serif', node.text ? palette.text : palette.muted);
        ctx.fillStyle = palette.muted;
        ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText((node.text || '').length + ' 字 · ' + incomingReferences(node).length + ' 张参考', bodyX, y + size.height - 12);
      } else {
        var imageHeight = node.type === 'image' ? 214 : 128;
        roundRectPath(ctx, bodyX, bodyY, bodyWidth, imageHeight, 8);
        ctx.fillStyle = palette.input;
        ctx.fill();
        if (image) {
          ctx.save();
          roundRectPath(ctx, bodyX, bodyY, bodyWidth, imageHeight, 8);
          ctx.clip();
          drawImageCover(ctx, image, bodyX, bodyY, bodyWidth, imageHeight);
          ctx.restore();
        } else {
          ctx.fillStyle = palette.muted;
          ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(node.status === 'generating' ? '正在生成图片…' : node.type === 'upload' ? '参考图片' : '图片生成结果', bodyX + bodyWidth / 2, bodyY + imageHeight / 2);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
        }
        var caption = node.type === 'upload' ? (node.name || '参考图片') : (node.provider ? node.provider + ' · ' + (node.model || '') : '等待生成或上传图片');
        ctx.fillStyle = palette.text;
        ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText(caption.length > 34 ? caption.slice(0, 33) + '…' : caption, bodyX, bodyY + imageHeight + 20);
        if (node.type === 'image' && node.prompt) {
          drawWrappedText(ctx, '提示词：' + node.prompt, bodyX, bodyY + imageHeight + 38, bodyWidth, 15, 2,
            '10px "Segoe UI", "Microsoft YaHei", sans-serif', palette.muted);
        }
      }
      if (node.locked) {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = palette.muted;
        ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText('已锁定', x + size.width - 12, y + size.height - 10);
      }
      ctx.restore();
    }

    async function renderCanvasPngBlob() {
      var bounds = allBounds();
      if (!bounds) throw new Error('画布是空的');
      var width = bounds.width + EXPORT_PADDING * 2;
      var height = bounds.height + EXPORT_PADDING * 2;
      var scale = Math.min(2, 6000 / Math.max(1, width), 6000 / Math.max(1, height));
      scale = Math.max(0.2, scale);
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
      var dark = theme !== 'light';
      var palette = dark ? {
        bg: '#111216', panel: '#1a1c22', input: '#14161b', border: '#343842',
        text: '#f1f2f5', muted: '#969caa', accent: '#a992ff', dot: '#343741'
      } : {
        bg: '#f4f5f8', panel: '#ffffff', input: '#f7f8fb', border: '#d8dbe5',
        text: '#242632', muted: '#747b8e', accent: '#7457d9', dot: '#d0d3df'
      };
      ctx.scale(scale, scale);
      ctx.translate(EXPORT_PADDING - bounds.minX, EXPORT_PADDING - bounds.minY);
      ctx.fillStyle = palette.bg;
      ctx.fillRect(bounds.minX - EXPORT_PADDING, bounds.minY - EXPORT_PADDING, width, height);
      ctx.fillStyle = palette.dot;
      var startX = Math.floor((bounds.minX - EXPORT_PADDING) / 24) * 24;
      var startY = Math.floor((bounds.minY - EXPORT_PADDING) / 24) * 24;
      for (var dotX = startX; dotX < bounds.minX + width; dotX += 24) {
        for (var dotY = startY; dotY < bounds.minY + height; dotY += 24) {
          ctx.fillRect(dotX, dotY, 1.2, 1.2);
        }
      }
      ctx.strokeStyle = palette.accent;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 2;
      edges.forEach(function (edge) {
        var from = getNode(edge.from);
        var to = getNode(edge.to);
        if (!from || !to) return;
        try {
          ctx.stroke(new Path2D(edgePath(portPosition(from, true), portPosition(to, false), NODE_HEIGHT[from.type], NODE_HEIGHT[to.type])));
        } catch (err) {
          // 极旧浏览器不支持 Path2D，跳过连线但仍导出节点。
        }
      });
      ctx.globalAlpha = 1;
      var images = {};
      var loaded = await Promise.all(nodes.map(function (node) {
        return node.url ? loadExportImage(node.url) : Promise.resolve(null);
      }));
      nodes.forEach(function (node, index) { images[node.id] = loaded[index]; });
      nodes.forEach(function (node) { drawExportNode(ctx, node, images[node.id], palette); });
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('图片编码失败'));
        }, 'image/png');
      });
    }

    async function exportCanvasImage() {
      if (generating) {
        notify('正在生成图片，请稍后再导出画布', 'info');
        return;
      }
      if (!nodes.length) {
        notify('画布是空的，没有可导出的内容', 'info');
        return;
      }
      try {
        var blob = await renderCanvasPngBlob();
        var name = 'ai-canvas-' + fileStamp() + '.png';
        downloadBlob(blob, name);
        notify('画布图片已导出：' + name, 'success', 4000);
      } catch (err) {
        notify('导出画布图片失败：' + errorMessage(err), 'error', 5000);
      }
    }

    function portPosition(node, output) {
      var size = nodeSize(node);
      return { x: output ? node.x + size.width : node.x, y: node.y + PORT_Y };
    }

    function edgePath(from, to, fromHeight, toHeight) {
      // 正向连线用平滑贝塞尔；目标在左侧时从两个节点的下方绕行，避免穿过节点或跑出画布。
      if (to.x >= from.x + 70) {
        var distance = Math.max(55, Math.abs(to.x - from.x) * 0.48);
        return 'M ' + from.x + ' ' + from.y + ' C ' + (from.x + distance) + ' ' + from.y + ', ' + (to.x - distance) + ' ' + to.y + ', ' + to.x + ' ' + to.y;
      }
      var fromBottom = fromHeight ? (from.y - PORT_Y + fromHeight) : from.y;
      var toBottom = toHeight ? (to.y - PORT_Y + toHeight) : to.y + 24;
      var midY = Math.max(fromBottom, toBottom) + 46;
      var x1 = from.x + 46;
      var x2 = to.x - 46;
      return 'M ' + from.x + ' ' + from.y +
        ' H ' + x1 +
        ' Q ' + (x1 + 16) + ' ' + from.y + ' ' + (x1 + 16) + ' ' + (from.y + 16) +
        ' V ' + (midY - 16) +
        ' Q ' + (x1 + 16) + ' ' + midY + ' ' + x1 + ' ' + midY +
        ' H ' + x2 +
        ' Q ' + (x2 - 16) + ' ' + midY + ' ' + (x2 - 16) + ' ' + (midY - 16) +
        ' V ' + (to.y + 16) +
        ' Q ' + (x2 - 16) + ' ' + to.y + ' ' + x2 + ' ' + to.y +
        ' H ' + to.x;
    }

    function drawEdges() {
      edges.forEach(function (edge) {
        var entry = edgeElements[edge.id];
        if (!entry) return;
        var fromNode = getNode(edge.from);
        var toNode = getNode(edge.to);
        if (!fromNode || !toNode) return;
        var from = portPosition(fromNode, true);
        var to = portPosition(toNode, false);
        var path = edgePath(from, to, NODE_HEIGHT[fromNode.type], NODE_HEIGHT[toNode.type]);
        entry.path.setAttribute('d', path);
        entry.hit.setAttribute('d', path);
        entry.path.classList.toggle('selected', edge.id === selectedEdgeId);
      });
    }

    function hasImage(node) {
      return node.type !== 'text' && Boolean(node.url || node.blobId);
    }

    function incomingReferences(node) {
      if (!node) return [];
      return edges.map(function (edge) {
        var source = getNode(edge.from);
        return edge.to === node.id && hasImage(source) ? source : null;
      }).filter(Boolean);
    }

    function renderNode(node) {
      var old = nodeElements[node.id];
      if (old) old.remove();
      var el = make('div', 'aic-node type-' + node.type);
      el.dataset.nodeId = node.id;
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', node.name + (node.locked ? '（已锁定）' : ''));
      el.classList.toggle('selected', isSelected(node.id));
      el.classList.toggle('generating', node.status === 'generating');
      el.classList.toggle('locked', Boolean(node.locked));

      var head = make('div', 'aic-node-head');
      head.appendChild(make('span', 'aic-node-mark', node.type === 'text' ? 'T' : node.type === 'upload' ? 'R' : 'I'));
      var title = make('span', 'aic-node-title', node.type === 'text' ? 'Text 提示词' : node.type === 'upload' ? '参考图片' : 'Image 结果');
      head.appendChild(title);
      head.appendChild(make('span', 'aic-node-meta', node.type === 'text' ? 'PROMPT' : node.type === 'upload' ? 'JPG / PNG / WebP' : node.size || 'IMAGE'));
      if (node.locked) {
        var lockMark = make('span', 'aic-node-lock', ICONS.lock);
        lockMark.title = '节点位置已锁定';
        head.appendChild(lockMark);
      }
      var menuButton = make('button', 'aic-node-menu', '⋯');
      menuButton.type = 'button';
      menuButton.title = '节点菜单';
      menuButton.setAttribute('aria-label', '节点菜单');
      head.appendChild(menuButton);
      el.appendChild(head);

      if (node.type !== 'text') {
        var output = make('button', 'aic-port output');
        output.type = 'button';
        output.title = '输出锚点：连接到此图片作为参考';
        output.setAttribute('aria-label', node.name + '输出锚点');
        output.disabled = !hasImage(node);
        el.appendChild(output);
      }
      if (node.type !== 'upload') {
        var input = make('button', 'aic-port input');
        input.type = 'button';
        input.title = '输入锚点：接收参考图片';
        input.setAttribute('aria-label', node.name + '输入锚点');
        el.appendChild(input);
      }

      var body = make('div', 'aic-node-body');
      if (node.type === 'text') {
        var textarea = make('textarea', 'aic-text-edit');
        textarea.value = node.text;
        textarea.placeholder = '输入画面主体、风格、光线等提示词…';
        textarea.maxLength = 12000;
        textarea.setAttribute('aria-label', 'Text 节点提示词');
        body.appendChild(textarea);
        var foot = make('div', 'aic-node-foot');
        var textCount = make('span', 'aic-text-count', node.text.length + ' 字');
        var refCount = make('span', 'aic-ref-count', '0 张参考');
        foot.appendChild(textCount);
        foot.appendChild(refCount);
        body.appendChild(foot);
        bind(textarea, 'input', function () {
          node.text = textarea.value;
          textCount.textContent = node.text.length + ' 字';
          if (currentText() === node) {
            promptInput.value = node.text;
            updatePromptCount();
          }
          updateDockStatus();
          scheduleSave();
        });
        bind(textarea, 'focus', function () {
          setActiveText(node);
          selectNode(node.id);
        });
        bind(textarea, 'pointerdown', function (event) { event.stopPropagation(); });
      } else {
        var thumb = make('div', 'aic-thumb' + (node.type === 'image' ? ' aic-image-wrap' : ''));
        var image = make('img');
        image.alt = node.type === 'upload' ? '参考图片' : '生成图片';
        image.draggable = false;
        image.hidden = !node.url;
        if (node.url) image.src = node.url;
        thumb.appendChild(image);
        if (!node.url) {
          var empty = make('div', 'aic-empty-thumb', node.status === 'generating' ? '正在生成图片…' : node.blobId ? '正在恢复本地图片…' : node.type === 'upload' ? '点击上传参考图片' : '空白 Image 节点');
          thumb.appendChild(empty);
        }
        body.appendChild(thumb);
        var caption = make('div', 'aic-node-caption');
        var name = make('span', '', node.type === 'upload' ? (node.name || '参考图片') : (node.provider ? node.provider + ' · ' + (node.model || '') : '等待生成或上传图片'));
        caption.appendChild(name);
        if (node.type === 'upload') {
          var replace = make('button', 'aic-mini-btn', '替换');
          replace.type = 'button';
          caption.appendChild(replace);
          bind(replace, 'click', function (event) {
            event.stopPropagation();
            chooseUploads(false, node.id);
          });
        }
        body.appendChild(caption);
        if (node.type === 'image') {
          var meta = make('div', 'aic-result-meta', node.status === 'generating' ? '正在请求生图服务，请稍候…' : node.prompt ? '提示词：' + node.prompt : '上传图片或使用底部控制台生成');
          body.appendChild(meta);
        }
        if (node.type === 'image') {
          var actions = make('div', 'aic-result-actions');
          var download = make('button', 'aic-btn', '下载图片');
          download.type = 'button';
          download.disabled = !node.url;
          var lightbox = make('button', 'aic-btn', '查看大图');
          lightbox.type = 'button';
          lightbox.disabled = !node.url;
          actions.appendChild(download);
          actions.appendChild(lightbox);
          body.appendChild(actions);
          bind(download, 'click', function (event) {
            event.stopPropagation();
            downloadImage(node);
          });
          bind(lightbox, 'click', function (event) {
            event.stopPropagation();
            openLightbox(node);
          });
        }
        bind(thumb, 'click', function (event) {
          event.stopPropagation();
          if (node.type === 'image') openLightbox(node);
          else chooseUploads(false, node.id);
        });
        bind(image, 'error', function () {
          if (!node.url || node.status === 'generating') return;
          image.hidden = true;
          thumb.appendChild(make('div', 'aic-empty-thumb', '图片暂时无法加载，可替换或删除节点'));
          notify('图片地址无法加载，请检查链接或重新上传', 'error');
        });
        bind(output, 'click', function (event) {
          event.stopPropagation();
          if (output.disabled) return;
          beginLink(node.id);
        });
      }
      if (node.type === 'text') {
        bind(el.querySelector('.aic-port.input'), 'click', function (event) {
          event.stopPropagation();
          finishLink(node.id);
        });
      } else if (node.type === 'image') {
        bind(el.querySelector('.aic-port.input'), 'click', function (event) {
          event.stopPropagation();
          finishLink(node.id);
        });
      }
      bind(menuButton, 'click', function (event) {
        event.stopPropagation();
        if (!isSelected(node.id)) selectNode(node.id);
        openMenuForNode(node.id, menuButton.getBoundingClientRect());
      });
      bind(el, 'pointerdown', onNodePointerDown);
      el.appendChild(body);
      if (node.status === 'generating') {
        var progress = make('div', 'aic-progress');
        progress.appendChild(make('span'));
        el.appendChild(progress);
      }
      world.appendChild(el);
      nodeElements[node.id] = el;
      updateNodeRefCount(node);
      if (node.blobId && !node.url) restoreNodeBlob(node);
    }

    function updateNodeRefCount(node) {
      var el = nodeElements[node.id];
      if (!el) return;
      var count = el.querySelector('.aic-ref-count');
      if (count) count.textContent = incomingReferences(node).length + ' 张参考';
    }

    function validReferenceBlob(blob) {
      return Boolean(blob && /^image\/(jpeg|png|webp)$/i.test(blob.type || '') &&
        blob.size > 0 && blob.size <= MAX_FILE_SIZE);
    }

    function loadReferenceBlob(node) {
      if (node && node.blobId && fileBlobs[node.blobId]) {
        return Promise.resolve({ blob: fileBlobs[node.blobId], name: node.name || '' });
      }
      if (!node || !node.blobId) {
        return Promise.reject(new Error('参考图片已失效，请重新上传'));
      }
      // 同一张图只读取一次，兼顾预览恢复与生成提交，也避免重复渲染反复读库。
      if (!blobLoads[node.blobId]) {
        // 大图上传后可能仍在写入 IndexedDB；等写入完成再读，避免生成时时序竞争。
        var ready = blobWrites[node.blobId]
          ? blobWrites[node.blobId].catch(function () { /* 写入失败时由调用方回退 fileBlobs */ })
          : Promise.resolve();
        blobLoads[node.blobId] = ready.then(function () {
          return getBlob(node.blobId);
        }).then(function (record) {
          if (!record || !validReferenceBlob(record.blob)) {
            throw new Error('本地参考图已失效，请重新上传');
          }
          return record;
        });
      }
      return blobLoads[node.blobId].then(function (record) {
        fileBlobs[node.blobId] = record.blob;
        return record;
      });
    }

    function restoreNodeBlob(node) {
      loadReferenceBlob(node).then(function (record) {
        var current = getNode(node.id);
        if (destroyed || !current || current.blobId !== node.blobId) return;
        if (!current.url) {
          current.url = URL.createObjectURL(record.blob);
          objectUrls.push(current.url);
        }
        if (!current.name || current.name === '参考图片') current.name = record.name || current.name;
        renderNode(current);
        scheduleSave();
      }).catch(function () {
        if (!destroyed && getNode(node.id)) notify('本地参考图已失效，请重新上传', 'error');
      });
    }

    function ensureEdgeElement(edge) {
      if (edgeElements[edge.id]) return edgeElements[edge.id];
      var path = document.createElementNS(svgNs, 'path');
      path.setAttribute('class', 'aic-edge');
      var hit = document.createElementNS(svgNs, 'path');
      hit.setAttribute('class', 'aic-edge-hit');
      hit.setAttribute('role', 'button');
      hit.setAttribute('aria-label', '参考连线');
      svg.insertBefore(hit, tempPath);
      svg.insertBefore(path, hit);
      bind(hit, 'click', function (event) {
        event.stopPropagation();
        applySelection([]);
        selectedEdgeId = edge.id;
        drawEdges();
        renderSelection();
      });
      bind(hit, 'dblclick', function (event) {
        event.stopPropagation();
        removeEdge(edge.id);
      });
      edgeElements[edge.id] = { path: path, hit: hit };
      return edgeElements[edge.id];
    }

    function renderEdges() {
      Object.keys(edgeElements).forEach(function (id) {
        if (!getEdge(id)) {
          edgeElements[id].path.remove();
          edgeElements[id].hit.remove();
          delete edgeElements[id];
        }
      });
      edges.forEach(function (edge) {
        if (getNode(edge.from) && getNode(edge.to)) ensureEdgeElement(edge);
      });
      drawEdges();
    }

    function renderSelection() {
      nodes.forEach(function (node) {
        if (nodeElements[node.id]) nodeElements[node.id].classList.toggle('selected', isSelected(node.id));
      });
    }

    function renderAll() {
      renderEdges();
      Object.keys(nodeElements).forEach(function (id) {
        if (!getNode(id)) {
          nodeElements[id].remove();
          delete nodeElements[id];
        }
      });
      nodes.forEach(renderNode);
      renderEdges();
      renderSelection();
      applyTransform();
      emptyState.hidden = nodes.length > 0;
      updateUndoButtons();
      updateDockStatus();
      updateProjectMeta();
      updateSelectionBar();
      scheduleMinimap();
    }

    function isSelected(id) {
      return selectedIds.indexOf(id) !== -1;
    }

    function applySelection(ids) {
      var unique = [];
      (Array.isArray(ids) ? ids : []).forEach(function (id) {
        if (getNode(id) && unique.indexOf(id) === -1) unique.push(id);
      });
      selectedIds = unique;
      selectedId = unique.length ? unique[unique.length - 1] : '';
      renderSelection();
      updateSelectionBar();
      scheduleMinimap();
    }

    function setSelection(ids) {
      selectedEdgeId = '';
      applySelection(ids);
      drawEdges();
    }

    function selectNode(id, mode) {
      if (!getNode(id)) return;
      if (mode === 'toggle') {
        var index = selectedIds.indexOf(id);
        if (index === -1) {
          applySelection(selectedIds.concat([id]));
          selectedId = id;
        } else {
          applySelection(selectedIds.filter(function (item) { return item !== id; }));
        }
      } else if (mode === 'add') {
        applySelection(selectedIds.concat([id]));
        selectedId = id;
      } else {
        setSelection([id]);
      }
      selectedEdgeId = '';
      drawEdges();
    }

    function clearSelection() {
      setSelection([]);
    }

    function updateSelectionBar() {
      if (!alignCount) return;
      var count = selectedIds.length;
      alignCount.textContent = '已选 ' + count + ' 个';
      alignBar.classList.toggle('show', count >= 2);
      alignButtons.forEach(function (button) {
        button.disabled = generating || count < Number(button.dataset.minCount || 2);
      });
    }

    function addNode(type, position, options) {
      if (generating) return null;
      if (nodes.length >= MAX_NODES) {
        notify('画布最多保存 ' + MAX_NODES + ' 个节点，请先删除部分节点', 'error');
        return null;
      }
      checkpoint();
      var point = position || centerWorld();
      var node = {
        id: uid('aic-node'), type: type, x: Math.round(point.x - NODE_WIDTH[type] / 2), y: Math.round(point.y - 45),
        text: '', name: type === 'text' ? 'Text 提示词' : type === 'upload' ? '参考图片' : 'Image 结果',
        url: '', path: '', blobId: '', mime: '', provider: '', model: '', prompt: '', size: '', status: '', locked: false
      };
      Object.assign(node, options || {});
      nodes.push(node);
      selectedIds = [node.id];
      selectedId = node.id;
      selectedEdgeId = '';
      renderAll();
      scheduleSave();
      if (type === 'text') {
        setActiveText(node);
        var editor = nodeElements[node.id] && nodeElements[node.id].querySelector('.aic-text-edit');
        if (editor) editor.focus();
      }
      setStatus('已添加节点');
      return node;
    }

    function deleteNodes(ids) {
      if (generating) return;
      var list = (ids || []).filter(function (id) { return getNode(id); });
      if (!list.length) return;
      var removed = {};
      list.forEach(function (id) { removed[id] = true; });
      checkpoint();
      nodes = nodes.filter(function (item) { return !removed[item.id]; });
      edges = edges.filter(function (edge) { return !removed[edge.from] && !removed[edge.to]; });
      if (removed[activeTextId]) activeTextId = '';
      if (removed[selectedId]) selectedId = '';
      if (link && removed[link.from]) cancelLink();
      selectedIds = selectedIds.filter(function (id) { return !removed[id]; });
      selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : '';
      renderAll();
      syncPrompt();
      scheduleSave();
      setStatus('已删除 ' + list.length + ' 个节点，可撤销');
    }

    function deleteSelection() {
      if (selectedIds.length) {
        deleteNodes(selectedIds.slice());
        return;
      }
      if (selectedEdgeId) removeEdge(selectedEdgeId);
    }

    function duplicateNodes(ids) {
      if (generating) return;
      var sources = (ids || []).map(getNode).filter(Boolean);
      if (!sources.length) return;
      if (nodes.length + sources.length > MAX_NODES) {
        notify('画布最多保存 ' + MAX_NODES + ' 个节点，请先删除部分节点', 'error');
        return;
      }
      checkpoint();
      var index = {};
      var created = [];
      sources.forEach(function (source) {
        var copy = Object.assign({}, source, {
          id: uid('aic-node'),
          x: source.x + 36,
          y: source.y + 36,
          name: source.type === 'text' ? 'Text 提示词副本' : source.type === 'upload' ? (source.name || '参考图片') : 'Image 结果副本',
          status: '',
          locked: false
        });
        index[source.id] = copy.id;
        nodes.push(copy);
        created.push(copy.id);
      });
      edges.slice().forEach(function (edge) {
        if (index[edge.from] && index[edge.to]) edges.push({ id: uid('edge'), from: index[edge.from], to: index[edge.to] });
      });
      selectedIds = created;
      selectedId = created[created.length - 1];
      selectedEdgeId = '';
      renderAll();
      scheduleSave();
      setStatus('已复制 ' + created.length + ' 个节点');
    }

    function copySelection() {
      if (!selectedIds.length) {
        notify('请先选择要复制的节点', 'info');
        return;
      }
      var selectedMap = {};
      selectedIds.forEach(function (id) { selectedMap[id] = true; });
      clipboard = {
        nodes: selectedIds.map(getNode).filter(Boolean).map(function (node) { return Object.assign({}, node); }),
        edges: edges.filter(function (edge) { return selectedMap[edge.from] && selectedMap[edge.to]; }).map(function (edge) { return Object.assign({}, edge); })
      };
      notify('已复制 ' + clipboard.nodes.length + ' 个节点，可粘贴到画布', 'success', 2200);
    }

    function pasteClipboard() {
      if (generating) return;
      if (!clipboard || !clipboard.nodes.length) {
        notify('剪贴板为空，先按 Ctrl / Command + C 复制节点', 'info');
        return;
      }
      if (nodes.length + clipboard.nodes.length > MAX_NODES) {
        notify('画布最多保存 ' + MAX_NODES + ' 个节点，请先删除部分节点', 'error');
        return;
      }
      checkpoint();
      var index = {};
      var created = [];
      clipboard.nodes.forEach(function (source) {
        var copy = Object.assign({}, source, {
          id: uid('aic-node'),
          x: source.x + 36,
          y: source.y + 36,
          status: '',
          locked: false
        });
        index[source.id] = copy.id;
        nodes.push(copy);
        created.push(copy.id);
      });
      clipboard.edges.forEach(function (edge) {
        if (index[edge.from] && index[edge.to]) edges.push({ id: uid('edge'), from: index[edge.from], to: index[edge.to] });
      });
      selectedIds = created;
      selectedId = created[created.length - 1];
      selectedEdgeId = '';
      renderAll();
      persistNow();
      setStatus('已粘贴 ' + created.length + ' 个节点');
    }

    function nudgeSelection(dx, dy) {
      if (!selectedIds.length || generating) return;
      var moved = false;
      checkpoint();
      selectedIds.forEach(function (id) {
        var node = getNode(id);
        if (!node || node.locked) return;
        node.x += dx;
        node.y += dy;
        moved = true;
      });
      if (!moved) {
        undoStack.pop();
        updateUndoButtons();
        return;
      }
      updateNodePositions();
      setStatus('已微调节点位置');
    }

    function connect(from, to) {
      if (!getNode(from) || !getNode(to) || from === to || generating) return false;
      if (edges.some(function (edge) { return edge.from === from && edge.to === to; })) {
        notify('这两个节点已经连接', 'info');
        return false;
      }
      checkpoint();
      edges.push({ id: uid('edge'), from: from, to: to });
      renderEdges();
      nodes.forEach(updateNodeRefCount);
      updateDockStatus();
      scheduleSave();
      setStatus('参考连线已建立');
      return true;
    }

    function removeEdge(id) {
      if (!getEdge(id) || generating) return;
      checkpoint();
      edges = edges.filter(function (edge) { return edge.id !== id; });
      selectedEdgeId = '';
      renderEdges();
      nodes.forEach(updateNodeRefCount);
      updateDockStatus();
      scheduleSave();
      setStatus('已断开连线，可撤销');
    }

    function beginLink(from) {
      if (generating) return;
      link = { from: from };
      viewportEl.classList.add('linking');
      tempPath.style.display = '';
      linkTip.hidden = false;
      nodes.forEach(function (node) {
        var input = nodeElements[node.id] && nodeElements[node.id].querySelector('.aic-port.input');
        if (input) input.classList.add('link-target');
      });
      updateTempLink();
      setStatus('点击 Text 或 Image 左侧输入锚点完成连线');
    }

    function finishLink(to) {
      if (!link) return;
      var from = link.from;
      cancelLink();
      connect(from, to);
    }

    function cancelLink() {
      link = null;
      viewportEl.classList.remove('linking');
      tempPath.style.display = 'none';
      linkTip.hidden = true;
      nodes.forEach(function (node) {
        var el = nodeElements[node.id];
        if (el) {
          var output = el.querySelector('.aic-port.output');
          var input = el.querySelector('.aic-port.input');
          if (output) output.classList.remove('armed');
          if (input) input.classList.remove('link-target');
        }
      });
      updateDockStatus();
    }

    function updateTempLink(clientX, clientY) {
      if (!link) return;
      var source = getNode(link.from);
      if (!source) return;
      var target = typeof clientX === 'number' ? screenToWorld(clientX, clientY) : portPosition(currentText() || source, false);
      tempPath.setAttribute('d', edgePath(portPosition(source, true), target, NODE_HEIGHT[source.type], 0));
    }

    function onNodePointerDown(event) {
      if (event.button !== 0 || event.target.closest('button,textarea,input,select')) return;
      var el = event.target.closest('.aic-node');
      var node = el && getNode(el.dataset.nodeId);
      if (!node || generating) return;
      event.stopPropagation();
      if (event.shiftKey) {
        selectNode(node.id, 'toggle');
        return;
      }
      if (!isSelected(node.id)) selectNode(node.id);
      else {
        selectedId = node.id;
        renderSelection();
        updateSelectionBar();
      }
      if (node.type === 'text') setActiveText(node);
      if (node.locked) {
        setStatus('节点位置已锁定，可通过右键菜单解锁');
        return;
      }
      var moving = {};
      var ids = selectedIds.filter(function (id) {
        var item = getNode(id);
        return item && !item.locked;
      });
      if (ids.indexOf(node.id) === -1) ids = [node.id];
      var starts = {};
      ids.forEach(function (id) {
        var item = getNode(id);
        moving[id] = true;
        starts[id] = { x: item.x, y: item.y };
      });
      var start = screenToWorld(event.clientX, event.clientY);
      drag = {
        primaryId: node.id,
        ids: ids,
        moving: moving,
        starts: starts,
        pointerId: event.pointerId,
        startX: start.x,
        startY: start.y,
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false
      };
      el.classList.add('dragging');
      try { el.setPointerCapture(event.pointerId); } catch (err) {
        // 合成事件或旧浏览器可能不支持指针捕获。
      }
    }

    function onPointerMove(event) {
      if (drag && event.pointerId === drag.pointerId) {
        var point = screenToWorld(event.clientX, event.clientY);
        var primary = getNode(drag.primaryId);
        if (!primary) return;
        if (!drag.moved && Math.abs(event.clientX - drag.startClientX) + Math.abs(event.clientY - drag.startClientY) < 3) return;
        if (!drag.moved) {
          drag.moved = true;
          checkpoint();
        }
        var primaryStart = drag.starts[drag.primaryId];
        var snapped = snapDrag(primary, primaryStart.x + (point.x - drag.startX), primaryStart.y + (point.y - drag.startY), drag.moving);
        var offsetX = snapped.x - primaryStart.x;
        var offsetY = snapped.y - primaryStart.y;
        drag.ids.forEach(function (id) {
          var node = getNode(id);
          if (!node) return;
          var start = drag.starts[id];
          node.x = Math.round(start.x + offsetX);
          node.y = Math.round(start.y + offsetY);
          var el = nodeElements[id];
          if (el) {
            el.style.left = node.x + 'px';
            el.style.top = node.y + 'px';
          }
        });
        drawEdges();
        drawGuides(snapped.v, snapped.h);
        scheduleMinimap();
      } else if (pan && event.pointerId === pan.pointerId) {
        viewport.x = pan.x + event.clientX - pan.clientX;
        viewport.y = pan.y + event.clientY - pan.clientY;
        applyTransform();
      } else if (marquee && event.pointerId === marquee.pointerId) {
        updateMarquee(event);
      } else if (link && typeof event.clientX === 'number') {
        updateTempLink(event.clientX, event.clientY);
      }
    }

    function endPointer(event) {
      if (drag && event.pointerId === drag.pointerId) {
        drag.ids.forEach(function (id) {
          var el = nodeElements[id];
          if (el) el.classList.remove('dragging');
        });
        if (drag.moved) scheduleSave();
        drag = null;
        clearGuides();
      }
      if (pan && event.pointerId === pan.pointerId) {
        pan = null;
        viewportEl.classList.remove('panning');
        scheduleSave();
      }
      if (marquee && event.pointerId === marquee.pointerId) {
        endMarquee();
      }
    }

    function openLightbox(node) {
      if (!node.url) {
        notify('该节点还没有图片', 'info');
        return;
      }
      if (typeof window.aiImageOpenLightbox !== 'function') {
        notify('大图查看功能尚未就绪', 'error');
        return;
      }
      try {
        window.aiImageOpenLightbox(node.url, {
          prompt: node.prompt || (node.type === 'text' ? node.text : ''),
          provider: node.provider || '',
          model: node.model || '',
          size: node.size || ''
        });
      } catch (err) {
        notify('打开大图失败：' + errorMessage(err), 'error');
      }
    }

    function downloadImage(node) {
      if (!node.url) return;
      var anchor = make('a');
      anchor.href = node.url;
      anchor.download = 'ai-image-' + Date.now() + '.' + (node.mime === 'image/png' ? 'png' : node.mime === 'image/webp' ? 'webp' : 'jpg');
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      notify('已开始下载图片', 'success');
    }

    function errorMessage(error) {
      if (!error) return '未知错误';
      if (typeof error === 'string') return error;
      return error.message || String(error);
    }

    function chooseUploads(linkAfter, replaceId) {
      if (generating) return;
      pendingUploadLink = Boolean(linkAfter);
      fileInput.dataset.replaceId = replaceId || '';
      fileInput.value = '';
      fileInput.click();
    }

    var ACCEPTED_UPLOAD_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];

    // 浏览器能解码但服务商不一定接受的格式（GIF/BMP/AVIF）先在本地转成 PNG。
    function convertToPngBlob(file) {
      return new Promise(function (resolve) {
        var url = '';
        try { url = URL.createObjectURL(file); } catch (err) { resolve(null); return; }
        var image = new Image();
        image.onload = function () {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || image.width;
            canvas.height = image.naturalHeight || image.height;
            canvas.getContext('2d').drawImage(image, 0, 0);
            canvas.toBlob(function (blob) {
              URL.revokeObjectURL(url);
              resolve(blob || null);
            }, 'image/png');
          } catch (err) {
            URL.revokeObjectURL(url);
            resolve(null);
          }
        };
        image.onerror = function () {
          URL.revokeObjectURL(url);
          resolve(null);
        };
        image.src = url;
      });
    }

    // 协作项目：把参考图上传到服务端，其他人打开画布时才看得到。
    function uploadToServer(file) {
      if (!SERVER || !SERVER.apiBase) return Promise.resolve('');
      return new Promise(function (resolve) {
        var form = new FormData();
        form.append('file', file, file.name || 'canvas.png');
        var headers = {};
        if (SERVER.csrfToken) headers['X-CSRF-Token'] = SERVER.csrfToken;
        fetch(SERVER.apiBase + '/uploads', { method: 'POST', body: form, headers: headers, credentials: 'same-origin' })
          .then(function (resp) { return resp.ok ? resp.json() : null; })
          .then(function (json) { resolve(json && json.success && json.url ? json.url : ''); })
          .catch(function () { resolve(''); });
      });
    }

    async function handleFiles(files) {
      var list = Array.prototype.slice.call(files || []);
      var replaceId = fileInput.dataset.replaceId || '';
      var accepted = [];
      for (var i = 0; i < list.length; i++) {
        var file = list[i];
        if (ACCEPTED_UPLOAD_TYPES.indexOf((file.type || '').toLowerCase()) === -1) {
          notify('仅支持 JPG、PNG、WebP、GIF、BMP、AVIF 图片，已跳过“' + file.name + '”', 'error');
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          notify('图片不能超过 100MB，已跳过“' + file.name + '”', 'error');
          continue;
        }
        if (!file.size) {
          notify('图片内容为空，已跳过“' + file.name + '”', 'error');
          continue;
        }
        if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].indexOf((file.type || '').toLowerCase()) === -1) {
          var converted = await convertToPngBlob(file);
          if (!converted) {
            notify('无法读取“' + file.name + '”的图片内容，请转换成 PNG/JPG 后重试', 'error');
            continue;
          }
          file = new File([converted], (file.name || 'image').replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' });
        }
        accepted.push(file);
      }
      if (!accepted.length) return;
      var target = currentText();
      if (pendingUploadLink && !target) target = addNode('text', centerWorld());
      var slot = 0;
      accepted.forEach(function (file) {
        slot++;
        var blobId = uid('aic-upload');
        var position = { x: 90 + ((nodes.length * 285 + slot * 30) % 950), y: 100 + ((nodes.length * 170) % 520) };
        var node;
        if (replaceId && getNode(replaceId) && accepted.length === 1) {
          checkpoint();
          node = getNode(replaceId);
          if (node.url && node.url.indexOf('blob:') === 0) {
            try { URL.revokeObjectURL(node.url); } catch (err) {
              // 浏览器可能已自动回收该地址。
            }
          }
          node.url = '';
          node.blobId = blobId;
          node.mime = file.type;
          node.name = file.name;
          renderAll();
        } else {
          node = addNode('upload', position, { blobId: blobId, mime: file.type, name: file.name });
        }
        if (!node) return;
        var shouldLink = pendingUploadLink;
        node.status = 'loading';
        // 大图不常驻 JS 内存：生成时从 IndexedDB 读取，避免多个 100MB 参考图把页面撑爆。
        var keepInMemory = file.size <= 20 * 1024 * 1024;
        if (keepInMemory) fileBlobs[blobId] = file;
        setStatus('正在载入“' + file.name + '”…');
        // 直接用 Blob URL 预览，避免 100MB 级参考图被 readAsDataURL 复制成更大的 base64 字符串。
        var previewUrl = '';
        try { previewUrl = URL.createObjectURL(file); } catch (err) {
          previewUrl = '';
        }
        if (!previewUrl) {
          node.status = '';
          notify('无法预览该图片，请重新选择', 'error');
          return;
        }
        node.url = previewUrl;
        node.status = '';
        objectUrls.push(previewUrl);
        renderNode(node);
        if (shouldLink && target) connect(node.id, target.id);
        scheduleSave();
        var writePromise = putBlob(blobId, file);
        blobWrites[blobId] = writePromise;
        writePromise.then(function () {
          delete blobWrites[blobId];
          if (destroyed || !getNode(node.id)) return;
          var current = getNode(node.id);
          if (current.blobId !== blobId) return;
          if (keepInMemory) {
            fileBlobs[blobId] = file;
            blobLoads[blobId] = Promise.resolve({ blob: file, name: file.name });
          }
          setStatus('参考图片已保存到本地');
        }, function () {
          delete blobWrites[blobId];
          if (destroyed || !getNode(node.id)) return;
          // IndexedDB 写入失败时退回内存，至少本次会话还能生成。
          fileBlobs[blobId] = file;
          delete blobLoads[blobId];
          notify('图片已显示，但浏览器未允许持久保存，刷新后可能丢失', 'error', 5000);
        });
      });
      pendingUploadLink = false;
    }

    function setGenerating(value, statusText) {
      generating = value;
      generateButton.disabled = value || !providers.length || !window.aiImageGenerate;
      generateButton.textContent = value ? '生成中…' : providers.length && window.aiImageGenerate ? '生成图片' : providers.length ? '等待生图服务' : '暂无服务商';
      cancelButton.hidden = !value;
      cancelButton.disabled = false;
      promptInput.disabled = value;
      providerField.input.disabled = value || !providers.length;
      modelField.input.disabled = value;
      sizeField.input.disabled = value;
      ratioField.input.disabled = value;
      qualityField.input.disabled = value;
      if (customWidthInput) customWidthInput.disabled = value;
      if (customHeightInput) customHeightInput.disabled = value;
      countField.input.disabled = value;
      referenceButton.disabled = value;
      addTextButton.disabled = value;
      addUploadButton.disabled = value;
      addImageButton.disabled = value;
      nodeButton.disabled = value;
      moreNodeButton.disabled = value;
      projectButton.disabled = value;
      updateUndoButtons();
      updateSelectionBar();
      if (statusText) setStatus(statusText);
    }

    async function generate() {
      if (generating || preparing) return;
      preparing = true;
      var loading = null;
      var task = null;
      var started = Date.now();
      var provider = '';
      var prompt = '';
      var params = null;
      try {
        if (typeof window.aiImageGenerate !== 'function') throw new Error('生图服务尚未就绪，请稍后重试');
        var text = currentText();
        prompt = promptInput.value.trim();
        if (!prompt) {
          promptInput.focus();
          throw new Error('请先输入提示词');
        }
        if (!text) {
          text = addNode('text', centerWorld());
          text.text = prompt;
          renderNode(text);
        }
        provider = providerField.input.value;
        var providerInfo = providers.filter(function (p) { return p.provider_key === provider; })[0];
        if (!providerInfo) throw new Error('请选择可用的生图服务商');
        var references = text ? incomingReferences(text) : [];
        if (references.length && !providerInfo.supports_img2img) {
          throw new Error('当前服务商不支持图生图，请断开参考连线或更换服务商');
        }

        // 先建立结果节点再读取参考图，避免读取期间重复点击产生并发任务。
        loading = addNode('image', {
          x: text ? text.x + 350 : 90,
          y: text ? text.y : 120
        }, {
          status: 'generating', prompt: prompt, provider: provider,
          model: modelField.input.value, size: currentSizeValue()
        });
        if (!loading) return;
        generationNodeIds = [loading.id];
        setGenerating(true, references.length > 1
          ? '正在准备 ' + references.length + ' 张参考图…'
          : (references.length ? '正在准备参考图…' : '正在生成图片…'));

        // 画布支持多参考图（服务商侧按能力取用，最多 4 张）：逐张读取，读取失败直接报错。
        var referenceFiles = [];
        for (var refIndex = 0; refIndex < references.length && refIndex < 4; refIndex++) {
          var reference = references[refIndex];
          var referenceFile = null;
          if (reference.blobId) {
            // 刷新或撤销后内存可能已清空，直接从 IndexedDB 取 Blob，
            // 不再 fetch(blob:)，避免被 connect-src CSP 拦截。
            var record = await loadReferenceBlob(reference);
            referenceFile = record.blob;
          } else if (reference.url && reference.url.indexOf('blob:') === 0) {
            throw new Error('参考图片已失效，请重新上传');
          } else if (reference.url) {
            var refResponse = await fetch(reference.url);
            if (!refResponse.ok) throw new Error('参考图片读取失败（HTTP ' + refResponse.status + '）');
            var blob = await refResponse.blob();
            if (!validReferenceBlob(blob)) throw new Error('参考图片不是受支持的格式或超过 100MB');
            referenceFile = blob;
          }
          if (referenceFile) {
            if (!validReferenceBlob(referenceFile)) throw new Error('参考图片不是受支持的格式或超过 100MB');
            referenceFiles.push(referenceFile);
          }
        }
        if (references.length > 4) notify('单次最多使用 4 张参考图，已忽略多余连线', 'info');
        params = {
          provider: provider,
          model: modelField.input.value,
          prompt: prompt,
          size: currentSizeValue(),
          n: Number(countField.input.value) || 1,
          seed: seedInput.value.trim() && isFinite(Number(seedInput.value.trim())) ? Number(seedInput.value.trim()) : undefined,
          style: styleField.input.value,
          negativePrompt: negativeInput.value.trim(),
          referenceFile: referenceFiles[0] || null,
          referenceFiles: referenceFiles
        };
        task = window.aiImageGenerate(params);
        currentTask = task;
        setStatus(referenceFiles.length > 1
          ? '正在使用 ' + referenceFiles.length + ' 张参考图生成…'
          : '正在生成图片…');
        var result = await task;
        if (destroyed || currentTask !== task) return;
        if (!result || !Array.isArray(result.images) || !result.images.length) throw new Error('服务未返回可用图片');
        var images = result.images.filter(function (image) { return image && safeImageUrl(image.url); });
        if (!images.length) throw new Error('服务返回的图片地址无效');
        setGenerating(false, '正在整理生成结果…');
        checkpoint();
        loading.status = '';
        loading.url = '';
        loading.prompt = safeText(result.prompt, prompt, 12000);
        loading.provider = safeText(result.provider || result.providerKey, provider, 120);
        loading.model = safeText(result.model, params.model, 200);
        loading.size = safeText(result.size, params.size, 40);
        loading.url = safeImageUrl(images[0].url);
        loading.path = safeText(images[0].path, '', 2000);
        loading.mime = loading.url.indexOf('data:image/png') === 0 ? 'image/png' :
          loading.url.indexOf('data:image/webp') === 0 ? 'image/webp' : 'image/jpeg';
        generationNodeIds = [loading.id];
        images.slice(1).forEach(function (image, index) {
          var extra = addNode('image', { x: loading.x + index * 320, y: loading.y + 400 }, {
            url: safeImageUrl(image.url), path: safeText(image.path, '', 2000), prompt: loading.prompt,
            provider: loading.provider, model: loading.model, size: loading.size, status: ''
          });
          if (extra) generationNodeIds.push(extra.id);
        });
        if (text) generationNodeIds.forEach(function (id) { connect(id, text.id); });
        renderAll();
        persistNow();
        var elapsed = Number(result.elapsedMs) || Date.now() - started;
        setGenerating(false, '生成完成，用时 ' + (elapsed / 1000).toFixed(1) + ' 秒');
        notify('已生成 ' + images.length + ' 张图片，并连接为下一轮参考' +
          (result.fallbackUsed ? '（已由 ' + loading.provider + ' 兜底生成）' : '') +
          (result.modelRecovered ? '（原模型暂不可用，已自动切换为 ' + safeText(result.model, '可用模型', 120) + '）' : '') +
          (result.referenceLimited ? '（该服务商仅使用第 1 张参考图）' : '') +
          (result.sizeAdjusted ? '（已按模型/服务商能力生成 ' + safeText(result.size, params.size, 40) + '）' : ''), 'success', 4500);
        pageData.used = (Number(pageData.used) || 0) + (Number(params.n) || 1);
        updateQuota();
      } catch (error) {
        if (destroyed || (task && currentTask !== task)) return;
        if (loading) {
          loading = getNode(loading.id);
          if (loading) {
            loading.status = 'error';
            loading.prompt = prompt;
            loading.provider = provider;
            loading.model = params ? params.model : modelField.input.value;
            loading.size = params ? params.size : currentSizeValue();
            renderNode(loading);
          }
        }
        var cancelled = /取消/.test(errorMessage(error));
        setGenerating(false, cancelled ? '已取消生成' : '生成失败');
        notify(cancelled ? '已取消生成' : '生成失败：' + errorMessage(error), cancelled ? 'info' : 'error', 6500);
      } finally {
        preparing = false;
        currentTask = null;
        generationNodeIds = [];
      }
    }

    function cancelGeneration() {
      if (!generating || !currentTask || typeof currentTask.cancel !== 'function') return;
      var task = currentTask;
      var request;
      try {
        request = task.cancel();
      } catch (err) {
        cancelButton.disabled = false;
        notify('取消请求失败，任务仍在后台运行', 'error', 5000);
        return;
      }
      if (!request || typeof request.then !== 'function') {
        cancelButton.disabled = false;
        setStatus('任务正在提交，请稍后重试取消');
        notify('任务正在提交，暂时无法取消', 'info', 4500);
        return;
      }
      cancelButton.disabled = true;
      setStatus('正在请求取消…');
      Promise.resolve(request).then(function(confirmed) {
        if (destroyed || currentTask !== task || !generating) return;
        if (confirmed) {
          setStatus('已取消生成');
          return;
        }
        cancelButton.disabled = false;
        setStatus('取消失败，任务仍在后台运行');
        notify('取消失败，任务仍在后台运行，请稍后重试', 'error', 5500);
      }, function() {
        if (destroyed || currentTask !== task || !generating) return;
        cancelButton.disabled = false;
        setStatus('取消失败，任务仍在后台运行');
        notify('取消请求失败，任务仍在后台运行，请稍后重试', 'error', 5500);
      });
    }

    function addMenuButton(label, action, danger, disabled, hint) {
      var button = make('button', danger ? 'danger' : '', label);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(disabled);
      if (hint) button.title = hint;
      bind(button, 'click', function () {
        hideMenu();
        action();
      });
      menu.appendChild(button);
    }

    function menuSeparator() {
      menu.appendChild(make('div', 'aic-menu-sep'));
    }

    function openMenuAt(clientX, clientY) {
      menu.hidden = false;
      var rect = root.getBoundingClientRect();
      var menuRect = menu.getBoundingClientRect();
      menu.style.left = clamp(clientX - rect.left, 6, root.clientWidth - menuRect.width - 6) + 'px';
      menu.style.top = clamp(clientY - rect.top, 6, root.clientHeight - menuRect.height - 6) + 'px';
      var first = menu.querySelector('button:not(:disabled)');
      if (first) first.focus({ preventScroll: true });
    }

    function hideMenu() {
      menu.hidden = true;
      menu.textContent = '';
    }

    function openMenuForNode(id, rect) {
      var node = getNode(id);
      if (!node) return;
      var multi = selectedIds.length > 1 && isSelected(id);
      menu.textContent = '';
      menu.appendChild(make('div', 'aic-menu-hint', multi ? '已选 ' + selectedIds.length + ' 个节点' : node.type === 'text' ? 'Text 提示词节点' : node.type === 'upload' ? '参考图片节点' : 'Image 结果节点'));
      addMenuButton(node.locked ? '解锁节点位置' : '锁定节点位置', function () { toggleLock(id); }, false, generating);
      if (node.type === 'upload') addMenuButton('替换图片', function () { chooseUploads(false, id); }, false, generating);
      if (node.type === 'image') addMenuButton('上传图片到此节点', function () { chooseUploads(false, id); }, false, generating);
      if (node.prompt || node.text) addMenuButton('复制提示词', function () { copyText(node.prompt || node.text, '提示词已复制'); }, false, generating);
      if (node.type !== 'text' && hasImage(node)) addMenuButton('复制图片', function () { copyImage(node); }, false, generating);
      if (node.type !== 'upload' && hasImage(node)) addMenuButton('连接到当前 Text', function () {
        var text = currentText();
        if (!text) {
          text = addNode('text', { x: node.x + 20, y: node.y + NODE_HEIGHT[node.type] + 40 });
        }
        if (text) connect(id, text.id);
      }, false, generating);
      if (node.type === 'image' && node.prompt) addMenuButton('按此参数重新生成', function () { regenerate(node); }, false, generating);
      if (node.type !== 'text' && node.url) {
        addMenuButton('查看大图', function () { openLightbox(node); }, false, generating);
        addMenuButton('下载图片', function () { downloadImage(node); }, false, generating);
      }
      menuSeparator();
      addMenuButton('添加 Text', function () { addNode('text'); }, false, generating);
      addMenuButton('上传图片', function () { chooseUploads(false); }, false, generating);
      addMenuButton('添加空白 Image', function () { addNode('image'); }, false, generating);
      menuSeparator();
      addMenuButton(multi ? '复制选中节点' : '复制节点', function () {
        duplicateNodes(multi ? selectedIds.slice() : [id]);
      }, false, generating, '快捷键：Ctrl / Command + D');
      addMenuButton(multi ? '删除选中节点' : '删除节点', function () {
        deleteNodes(multi ? selectedIds.slice() : [id]);
      }, true, generating, '快捷键：Delete');
      menuSeparator();
      addMenuButton('撤销', undo, false, !undoStack.length || generating, '快捷键：Ctrl / Command + Z');
      addMenuButton('重做', redo, false, !redoStack.length || generating);
      openMenuAt(rect.left, rect.bottom + 4);
    }

    function openProjectMenu(button) {
      menu.textContent = '';
      menu.appendChild(make('div', 'aic-menu-hint', '项目'));
      addMenuButton('导出项目（JSON）', exportProject, false, !nodes.length);
      addMenuButton('导出画布图片（PNG）', exportCanvasImage, false, !nodes.length || generating);
      addMenuButton('导入项目…', function () {
        importInput.value = '';
        importInput.click();
      }, false, generating);
      menuSeparator();
      addMenuButton('自动布局', autoLayout, false, generating || nodes.length < 2);
      addMenuButton('全选节点', selectAllNodes, false, !nodes.length);
      addMenuButton('清空画布', clearCanvas, true, generating || !nodes.length);
      menuSeparator();
      addMenuButton('快捷键与帮助', openHelp);
      var rect = button.getBoundingClientRect();
      openMenuAt(rect.left, rect.bottom + 4);
    }

    function openCanvasMenu(clientX, clientY) {
      menu.textContent = '';
      menu.appendChild(make('div', 'aic-menu-hint', '画布'));
      addMenuButton('上传图片', function () { chooseUploads(true); }, false, generating);
      addMenuButton('添加 Text', function () { addNode('text', screenToWorld(clientX, clientY)); }, false, generating);
      addMenuButton('添加空白 Image', function () { addNode('image', screenToWorld(clientX, clientY)); }, false, generating);
      menuSeparator();
      addMenuButton('全选节点', selectAllNodes, false, !nodes.length);
      addMenuButton('自动布局', autoLayout, false, generating || nodes.length < 2);
      addMenuButton('适应视图', fitView);
      addMenuButton('恢复 100%', resetZoom);
      menuSeparator();
      addMenuButton('导出项目（JSON）', exportProject, false, !nodes.length);
      addMenuButton('快捷键与帮助', openHelp);
      addMenuButton('撤销', undo, false, !undoStack.length || generating);
      addMenuButton('重做', redo, false, !redoStack.length || generating);
      openMenuAt(clientX, clientY);
    }

    function openMoreNodeMenu(button) {
      menu.textContent = '';
      menu.appendChild(make('div', 'aic-menu-hint', '添加节点'));
      addMenuButton('Text 提示词', function () { addNode('text'); }, false, generating);
      addMenuButton('上传参考图片', function () { chooseUploads(true); }, false, generating);
      addMenuButton('空白 Image', function () { addNode('image'); }, false, generating);
      var rect = button.getBoundingClientRect();
      openMenuAt(rect.left, rect.top - menu.getBoundingClientRect().height - 6);
    }

    function toggleHelp() {
      if (helpMask.classList.contains('show')) closeHelp();
      else openHelp();
    }

    function setSnap(value) {
      snapEnabled = Boolean(value);
      snapButton.classList.toggle('active', snapEnabled);
      snapButton.setAttribute('aria-pressed', snapEnabled ? 'true' : 'false');
      saveFlag(SNAP_KEY, snapEnabled);
      if (!snapEnabled) clearGuides();
      notify(snapEnabled ? '已开启智能吸附：网格 + 对齐参考线' : '已关闭智能吸附', 'success', 1800);
    }

    function setMinimap(value) {
      minimapVisible = Boolean(value);
      minimapPanel.classList.toggle('show', minimapVisible);
      minimapButton.classList.toggle('active', minimapVisible);
      minimapButton.setAttribute('aria-pressed', minimapVisible ? 'true' : 'false');
      saveFlag(MINIMAP_KEY, minimapVisible);
      if (minimapVisible) scheduleMinimap();
    }

    function canvasActive() {
      return Boolean(root && root.isConnected && root.clientWidth && root.clientHeight && window.getComputedStyle(root).display !== 'none');
    }

    bind(viewportEl, 'pointerdown', function (event) {
      if (event.button !== 0 && event.button !== 1) return;
      if (event.target.closest('.aic-node,.aic-edge-hit,.aic-menu')) return;
      hideMenu();
      if (link) {
        cancelLink();
        return;
      }
      if (event.button === 1 || handButton.classList.contains('active') || spaceDown) {
        event.preventDefault();
        pan = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: viewport.x, y: viewport.y };
        viewportEl.classList.add('panning');
        try { viewportEl.setPointerCapture(event.pointerId); } catch (err) {
          // 合成事件或旧浏览器可能不支持指针捕获。
        }
        return;
      }
      beginMarquee(event);
    });
    bind(viewportEl, 'pointermove', onPointerMove);
    bind(viewportEl, 'pointerup', endPointer);
    bind(viewportEl, 'pointercancel', endPointer);
    bind(viewportEl, 'wheel', function (event) {
      event.preventDefault();
      zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
    }, { passive: false });
    bind(viewportEl, 'contextmenu', function (event) {
      event.preventDefault();
      var nodeEl = event.target.closest('.aic-node');
      if (nodeEl && getNode(nodeEl.dataset.nodeId)) openMenuForNode(nodeEl.dataset.nodeId, { left: event.clientX, top: event.clientY });
      else openCanvasMenu(event.clientX, event.clientY);
    });
    bind(root, 'pointerdown', function (event) {
      if (!event.target.closest('.aic-menu,.aic-node-menu,.aic-dock,.aic-help,.aic-align,.aic-minimap')) hideMenu();
    });

    bind(handButton, 'click', function () {
      handButton.classList.add('active');
      cursorButton.classList.remove('active');
      viewportEl.style.cursor = 'grab';
    });
    bind(cursorButton, 'click', function () {
      cursorButton.classList.add('active');
      handButton.classList.remove('active');
      viewportEl.style.cursor = 'default';
    });
    bind(addTextButton, 'click', function () { addNode('text'); });
    bind(addUploadButton, 'click', function () { chooseUploads(false); });
    bind(addImageButton, 'click', function () { addNode('image'); });
    bind(fitButton, 'click', fitView);
    bind(zoomFit, 'click', fitView);
    bind(zoomIn, 'click', function () { zoomAt(1.2); });
    bind(zoomOut, 'click', function () { zoomAt(1 / 1.2); });
    bind(zoomValue, 'click', resetZoom);
    bind(zoomValue, 'keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        resetZoom();
      }
    });
    bind(snapButton, 'click', function () { setSnap(!snapEnabled); });
    bind(minimapButton, 'click', function () { setMinimap(!minimapVisible); });
    bind(miniCanvas, 'pointerdown', function (event) {
      event.stopPropagation();
      minimapDragging = true;
      try { miniCanvas.setPointerCapture(event.pointerId); } catch (err) {
        // 忽略不支持指针捕获的环境。
      }
      minimapJumpTo(event);
    });
    bind(miniCanvas, 'pointermove', function (event) {
      if (minimapDragging) minimapJumpTo(event);
    });
    bind(miniCanvas, 'pointerup', function () { minimapDragging = false; });
    bind(miniCanvas, 'pointercancel', function () { minimapDragging = false; });
    bind(undoButton, 'click', undo);
    bind(redoButton, 'click', redo);
    bind(projectButton, 'click', function (event) {
      event.stopPropagation();
      openProjectMenu(projectButton);
    });
    bind(helpButton, 'click', toggleHelp);
    bind(helpClose, 'click', closeHelp);
    bind(helpMask, 'click', function (event) {
      if (event.target === helpMask) closeHelp();
    });
    bind(importInput, 'change', function () {
      var file = importInput.files && importInput.files[0];
      importInput.value = '';
      if (file) importProjectFile(file);
    });
    bind(themeButton, 'click', function () {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.classList.toggle('light', theme === 'light');
      themeButton.textContent = theme === 'dark' ? '亮' : '暗';
      saveTheme(theme);
      scheduleMinimap();
      notify(theme === 'dark' ? '已切换为暗色主题' : '已切换为亮色主题', 'success', 1800);
    });
    bind(simpleButton, 'click', function () {
      if (typeof window.aiImageSetMode !== 'function') {
        notify('简洁表单模式尚未就绪', 'error');
        return;
      }
      try { window.aiImageSetMode('simple'); } catch (err) { notify('切换模式失败：' + errorMessage(err), 'error'); }
    });
    bind(referenceButton, 'click', function () { chooseUploads(true); });
    bind(nodeButton, 'click', function () { addNode('image'); });
    bind(moreNodeButton, 'click', function (event) { event.stopPropagation(); openMoreNodeMenu(moreNodeButton); });
    bind(moreSettingsButton, 'click', function () {
      var open = moreRow.classList.toggle('open');
      moreSettingsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      moreSettingsButton.classList.toggle('active', open);
    });
    bind(promptInput, 'input', syncPrompt);
    bind(generateButton, 'click', generate);
    bind(cancelButton, 'click', cancelGeneration);
    bind(fileInput, 'change', function () { handleFiles(fileInput.files); });
    [providerField.input, modelField.input, sizeField.input, countField.input, seedInput, styleField.input, negativeInput].forEach(function (input) {
      bind(input, 'change', function () {
        if (input === providerField.input) renderModels();
        updateProviderCapabilities();
        scheduleSave();
      });
      if (input === seedInput || input === negativeInput) bind(input, 'input', scheduleSave);
    });

    bind(window, 'keydown', function (event) {
      if (!canvasActive()) return;
      var target = event.target;
      var editing = Boolean(target && target.closest && target.closest('textarea,input,select,[contenteditable="true"]'));
      var mod = event.ctrlKey || event.metaKey;
      var lightbox = document.getElementById('aiimgLightbox');
      if (lightbox && lightbox.style.display === 'flex') return;
      if (event.key === 'Escape') {
        if (helpMask.classList.contains('show')) {
          closeHelp();
          return;
        }
        hideMenu();
        if (link) cancelLink();
        if (marquee) endMarquee();
        clearSelection();
        return;
      }
      if (helpMask.classList.contains('show')) {
        if (event.key === '?' || (event.shiftKey && event.key === '/')) {
          event.preventDefault();
          closeHelp();
        }
        return;
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault();
        generate();
        return;
      }
      if (editing) return;
      if (event.key === ' ' || event.code === 'Space') {
        if (target && target.closest && target.closest('button,a')) return;
        if (!spaceDown) {
          spaceDown = true;
          viewportEl.style.cursor = 'grab';
        }
        event.preventDefault();
        return;
      }
      if (event.key === '?' || (event.shiftKey && event.key === '/')) {
        event.preventDefault();
        toggleHelp();
        return;
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllNodes();
      } else if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        if (selectedIds.length) duplicateNodes(selectedIds.slice());
      } else if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelection();
      } else if (mod && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteClipboard();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedIds.length || selectedEdgeId) {
          event.preventDefault();
          deleteSelection();
        }
      } else if (event.key === '0') {
        event.preventDefault();
        resetZoom();
      } else if (event.key === '1' || event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fitView();
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomAt(1.2);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomAt(1 / 1.2);
      } else if (event.key.indexOf('Arrow') === 0 && selectedIds.length) {
        event.preventDefault();
        var step = event.shiftKey ? 10 : 1;
        if (event.key === 'ArrowLeft') nudgeSelection(-step, 0);
        else if (event.key === 'ArrowRight') nudgeSelection(step, 0);
        else if (event.key === 'ArrowUp') nudgeSelection(0, -step);
        else if (event.key === 'ArrowDown') nudgeSelection(0, step);
      }
    });
    bind(window, 'keyup', function (event) {
      if (event.key === ' ' || event.code === 'Space') {
        spaceDown = false;
        viewportEl.style.cursor = handButton.classList.contains('active') ? 'grab' : 'default';
      }
    });

    bind(window, 'resize', function () {
      scheduleMinimap();
      if (fitWhenVisible && viewportEl.clientWidth && viewportEl.clientHeight) fitView();
    });
    bind(window, 'ai-image-mode-change', function (event) {
      if (!event.detail || event.detail.mode !== 'canvas') return;
      // 简洁模式会隐藏画布；重新显示后按当前容器尺寸恢复首次视图。
      if (fitWhenVisible) requestAnimationFrame(fitView);
      else renderAll();
    });

    var resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(function () {
        if (fitWhenVisible && viewportEl.clientWidth && viewportEl.clientHeight) fitView();
      });
      resizeObserver.observe(root);
    }

    updateQuota();
    applyPrefs(prefs);
    if (state.prompt || (currentText() && currentText().text)) promptInput.value = state.prompt || currentText().text;
    updatePromptCount();
    updateProjectMeta();
    updateSelectionBar();
    renderAll();
    applyTransform();
    if (fitWhenVisible) requestAnimationFrame(fitView);
    startCollab();

    var api = {
      root: root,
      refresh: function () {
        pageData = readDataElement();
        updateQuota();
        updateProviderCapabilities();
      },
      syncProviders: syncProviderModels,
      getState: function () {
        return captureCurrent();
      },
      // 载入服务端/分享链接里的画布状态（协作同步与项目切换共用）
      applyState: function (nextState) {
        applyServerState(nextState || {});
        setSaveState('已载入画布');
      },
      saveNow: pushServerState,
      getServerVersion: function () { return serverSync.version; },
      // 生成历史 / 素材复用：在视口中心插入一个已生成结果的 Image 节点
      addImageNode: function (data) {
        data = data || {};
        var url = safeImageUrl(data.url);
        if (!url) return null;
        var center = centerWorld();
        var offset = (nodes.length % 6) * 28;
        checkpoint();
        var node = addNode('image', { x: center.x - 144 + offset, y: center.y - 186 + offset }, {
          url: url,
          path: safeText(data.path, '', 2000),
          prompt: safeText(data.prompt, '', 12000),
          provider: safeText(data.provider, '', 120),
          model: safeText(data.model, '', 200),
          size: safeText(data.size, '', 40),
          status: ''
        });
        if (!node) return null;
        renderAll();
        scheduleSave();
        return node.id;
      },
      fitView: fitView,
      destroy: function () {
        if (destroyed) return;
        persistNow();
        destroyed = true;
        clearTimeout(saveTimer);
        clearTimeout(toastTimer);
        destroyHandlers.forEach(function (entry) { entry.target.removeEventListener(entry.type, entry.handler, entry.options); });
        destroyHandlers = [];
        if (resizeObserver) resizeObserver.disconnect();
        objectUrls.forEach(function (url) {
          try { URL.revokeObjectURL(url); } catch (err) {
            // 忽略已经失效的 Blob URL。
          }
        });
        if (generating && currentTask && typeof currentTask.cancel === 'function') {
          try { currentTask.cancel(); } catch (err) {
            // 取消失败不阻断 Promise 的最终状态处理。
          }
        }
        root.textContent = '';
        root.classList.remove('aic', 'light');
        delete root.__aiImageCanvas;
        if (initializedRoot === root) initializedRoot = null;
      }
    };
    root.__aiImageCanvas = api;
    return api;
  }
})();
