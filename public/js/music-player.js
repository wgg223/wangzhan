/**
 * 全站音乐悬浮播放器
 * - 悬浮球可拖动，点击展开播放面板（歌单来自 /api/music/list）
 * - 默认播放《明天会更好》（无同名歌曲时播第一首；记忆上次播放的歌）
 * - 跨页面续播：播放进度写 localStorage，新页面自动续播（浏览器拦截时点击继续）
 * - 多窗口只有一个播放：BroadcastChannel 抢占，后来者播放会让其他窗口自动暂停
 */
(function () {
  'use strict';
  if (window.__MUSIC_PLAYER__) return;
  window.__MUSIC_PLAYER__ = true;

  var LS_POS = 'mp.pos';
  var LS_UI = 'mp.ui';
  var TAB_ID = 'tab-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  var CH = null;
  try { CH = 'BroadcastChannel' in window ? new BroadcastChannel('mp-sync') : null; } catch (e) { CH = null; }

  var tracks = [];
  var current = -1;
  var audio = new Audio();
  audio.preload = 'metadata';
  var ball, panel, root, titleEl, listEl, btnPlay, seekEl, timeEl, durEl, volEl, tipEl;
  var dragging = false, dragMoved = false, dragX = 0, dragY = 0, startLeft = 0, startTop = 0;
  var remotePlaying = false;
  var pendingResume = false, resumeTarget = 0, probeAnswered = false;

  // ============ 存取 ============

  function loadJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function savePos() {
    if (remotePlaying) return; // 让位窗口不覆盖正在播的窗口的进度
    try {
      localStorage.setItem(LS_POS, JSON.stringify({
        src: current >= 0 ? tracks[current].src : null,
        t: audio.currentTime || 0,
        ts: Date.now(),
        vol: audio.volume,
        on: !audio.paused
      }));
    } catch (e) { /* 忽略 */ }
  }

  function saveUI() {
    try { localStorage.setItem(LS_UI, JSON.stringify({ x: root.style.left, y: root.style.top })); } catch (e) { /* 忽略 */ }
  }

  // ============ 多窗口协作 ============

  function post(type) {
    if (!CH) return;
    try { CH.postMessage({ type: type, tab: TAB_ID }); } catch (e) { /* 忽略 */ }
  }

  if (CH) {
    CH.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.tab === TAB_ID) return;
      if (m.type === 'play') {
        // 别的窗口开始播放：本窗口让位
        if (!audio.paused) audio.pause();
        remotePlaying = true;
        setTip('其他窗口正在播放');
      } else if (m.type === 'probe') {
        if (!audio.paused && !remotePlaying) post('playing');
      } else if (m.type === 'playing') {
        probeAnswered = true;
        remotePlaying = true;
        setTip('其他窗口正在播放');
      } else if (m.type === 'release') {
        if (remotePlaying) {
          remotePlaying = false;
          setTip('点击播放按钮继续');
        }
      }
    };
  }

  // ============ 播放控制 ============

  function setTip(text) { if (tipEl) tipEl.textContent = text || ''; }

  function refreshPlayBtn() {
    if (!btnPlay) return;
    btnPlay.textContent = audio.paused ? '▶' : '❚❚';
    ball.classList.toggle('mp-playing', !audio.paused);
    if (!audio.paused) ball.classList.remove('mp-ask');
  }

  function selectTrack(index, autoplay) {
    if (index < 0 || index >= tracks.length) return;
    current = index;
    remotePlaying = false;
    audio.src = tracks[index].src;
    titleEl.textContent = tracks[index].title;
    highlightList();
    if (autoplay !== false) startPlay();
  }

  function highlightList() {
    var items = listEl.children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('mp-active', i === current);
    }
  }

  function startPlay() {
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function () {
        ball.classList.add('mp-ask');
        setTip('点击继续播放');
      });
    }
  }

  function togglePlay() {
    if (current < 0) { if (tracks.length) selectTrack(0); return; }
    if (audio.paused) {
      remotePlaying = false;
      setTip('');
      startPlay();
    } else {
      audio.pause();
      savePos();
      post('release');
    }
  }

  function step(delta) {
    if (!tracks.length) return;
    selectTrack((current + delta + tracks.length) % tracks.length);
  }

  // ============ UI 构建 ============

  function buildDom() {
    root = document.createElement('div');
    root.id = 'mpRoot';

    panel = document.createElement('div');
    panel.className = 'mp-panel';
    panel.hidden = true;

    var head = document.createElement('div');
    head.className = 'mp-head';
    titleEl = document.createElement('span');
    titleEl.className = 'mp-title';
    titleEl.textContent = '未选择歌曲';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mp-close';
    closeBtn.setAttribute('aria-label', '收起');
    closeBtn.textContent = '×';
    head.appendChild(titleEl);
    head.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'mp-body';

    var row = document.createElement('div');
    row.className = 'mp-row';
    timeEl = document.createElement('span');
    timeEl.className = 'mp-time';
    timeEl.textContent = '0:00';
    seekEl = document.createElement('input');
    seekEl.type = 'range';
    seekEl.className = 'mp-seek';
    seekEl.min = '0'; seekEl.max = '1000'; seekEl.value = '0';
    durEl = document.createElement('span');
    durEl.className = 'mp-time';
    durEl.textContent = '0:00';
    row.appendChild(timeEl); row.appendChild(seekEl); row.appendChild(durEl);

    var ctrl = document.createElement('div');
    ctrl.className = 'mp-ctrl';
    var prevBtn = mkBtn('mp-btn', '⏮', '上一首');
    btnPlay = mkBtn('mp-btn mp-play', '▶', '播放/暂停');
    var nextBtn = mkBtn('mp-btn', '⏭', '下一首');
    var volIco = document.createElement('span');
    volIco.className = 'mp-vol-ico';
    volIco.textContent = '🔊';
    volEl = document.createElement('input');
    volEl.type = 'range';
    volEl.className = 'mp-vol';
    volEl.min = '0'; volEl.max = '100'; volEl.value = '80';
    ctrl.appendChild(prevBtn); ctrl.appendChild(btnPlay); ctrl.appendChild(nextBtn);
    ctrl.appendChild(volIco); ctrl.appendChild(volEl);

    tipEl = document.createElement('div');
    tipEl.className = 'mp-tip';

    listEl = document.createElement('ul');
    listEl.className = 'mp-list';

    body.appendChild(row); body.appendChild(ctrl); body.appendChild(tipEl); body.appendChild(listEl);
    panel.appendChild(head); panel.appendChild(body);

    ball = document.createElement('button');
    ball.type = 'button';
    ball.className = 'mp-ball';
    ball.setAttribute('aria-label', '音乐播放器');
    ball.textContent = '🎵';

    root.appendChild(panel);
    root.appendChild(ball);
    document.body.appendChild(root);

    var saved = loadJson(LS_UI);
    if (saved && saved.x && saved.y) {
      root.style.left = saved.x;
      root.style.top = saved.y;
    } else {
      placeDefault();
    }

    // 悬浮球：拖动 / 点击展开收起
    ball.addEventListener('pointerdown', function (e) {
      dragging = true; dragMoved = false;
      dragX = e.clientX; dragY = e.clientY;
      var r = root.getBoundingClientRect();
      startLeft = r.left; startTop = r.top;
      ball.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    ball.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - dragX, dy = e.clientY - dragY;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
      if (dragMoved) moveRoot(startLeft + dx, startTop + dy);
    });
    ball.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      try { ball.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (dragMoved) saveUI();
      else panel.hidden = !panel.hidden;
    });

    closeBtn.addEventListener('click', function () { panel.hidden = true; });
    btnPlay.addEventListener('click', togglePlay);
    prevBtn.addEventListener('click', function () { step(-1); });
    nextBtn.addEventListener('click', function () { step(1); });

    seekEl.addEventListener('input', function () {
      if (audio.duration) audio.currentTime = audio.duration * (seekEl.value / 1000);
    });
    volEl.addEventListener('input', function () {
      audio.volume = volEl.value / 100;
      savePos();
    });

    window.addEventListener('resize', function () {
      var r = root.getBoundingClientRect();
      moveRoot(Math.min(r.left, window.innerWidth - 62), Math.min(r.top, window.innerHeight - 62));
    });
  }

  function mkBtn(cls, text, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.setAttribute('aria-label', label);
    return b;
  }

  function placeDefault() {
    root.style.left = (window.innerWidth - 76) + 'px';
    root.style.top = (window.innerHeight - 96) + 'px';
  }

  function moveRoot(x, y) {
    x = Math.max(8, Math.min(x, window.innerWidth - 62));
    y = Math.max(8, Math.min(y, window.innerHeight - 62));
    root.style.left = x + 'px';
    root.style.top = y + 'px';
  }

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function renderList() {
    listEl.innerHTML = '';
    tracks.forEach(function (t, i) {
      var li = document.createElement('li');
      li.className = 'mp-item' + (i === current ? ' mp-active' : '');
      li.textContent = t.title;
      li.title = t.title;
      li.addEventListener('click', function () { selectTrack(i); });
      listEl.appendChild(li);
    });
  }

  // ============ 音频事件 ============

  audio.addEventListener('loadedmetadata', function () {
    durEl.textContent = fmt(audio.duration);
    if (resumeTarget > 1 && resumeTarget < audio.duration - 1) {
      try { audio.currentTime = resumeTarget; } catch (e) { /* 忽略 */ }
    }
    if (pendingResume) {
      pendingResume = false;
      startPlay();
    }
  });
  audio.addEventListener('play', function () {
    // 真实开播才广播抢占，避免被自动播放拦截时误让其他窗口暂停
    post('play');
    refreshPlayBtn();
    setTip('');
    savePos();
  });
  audio.addEventListener('pause', function () { refreshPlayBtn(); });
  audio.addEventListener('ended', function () { step(1); });
  audio.addEventListener('error', function () {
    if (current >= 0) setTip('该音频加载失败，请换一首');
  });
  audio.addEventListener('timeupdate', function () {
    timeEl.textContent = fmt(audio.currentTime);
    if (audio.duration && !remotePlaying) {
      seekEl.value = Math.round((audio.currentTime / audio.duration) * 1000);
    }
  });
  window.addEventListener('pagehide', function () {
    savePos();
    if (!audio.paused && !remotePlaying) post('release');
  });

  // ============ 初始化 ============

  function pickIndex(savedSrc, defaultTitle) {
    var i;
    if (savedSrc) {
      for (i = 0; i < tracks.length; i++) if (tracks[i].src === savedSrc) return i;
    }
    if (defaultTitle) {
      for (i = 0; i < tracks.length; i++) if (tracks[i].title === defaultTitle) return i;
    }
    return tracks.length ? 0 : -1;
  }

  function tryResumeOnLoad() {
    probeAnswered = false;
    post('probe');
    setTimeout(function () {
      if (probeAnswered) {
        refreshPlayBtn();
        return; // 其他窗口在播，本窗口不抢
      }
      ball.classList.add('mp-ask');
      pendingResume = true;
      if (audio.readyState >= 1) {
        pendingResume = false;
        startPlay();
      }
    }, 450);
  }

  function init() {
    buildDom();
    fetch('/api/music/list').then(function (r) { return r.json(); }).then(function (json) {
      var data = json.data || {};
      tracks = data.tracks || [];
      if (!tracks.length) {
        root.style.display = 'none';
        return;
      }
      renderList();

      var pos = loadJson(LS_POS);
      var idx = pickIndex(pos && pos.src, data.defaultTitle);
      if (idx < 0) return;
      current = idx;
      audio.src = tracks[idx].src;
      titleEl.textContent = tracks[idx].title;
      highlightList();
      if (pos && typeof pos.vol === 'number') {
        audio.volume = pos.vol;
        volEl.value = Math.round(pos.vol * 100);
      }

      if (pos && pos.on) {
        var elapsed = Math.max(0, (Date.now() - (pos.ts || Date.now())) / 1000);
        resumeTarget = (pos.t || 0) + elapsed;
        tryResumeOnLoad();
      }
    }).catch(function () { /* 接口异常不干扰页面 */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
