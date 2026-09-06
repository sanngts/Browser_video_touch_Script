// ==UserScript==
// @name         视频触屏滑动脚本
// @namespace    http://tampermonkey.net/
// @version      1.1.3
// @description  全屏横滑预览并跳转进度、竖滑调暗画面、长按二倍速；屏蔽全屏视频右键菜单
// @author       sanngtsu
// @match        *://*/*
// @grant        none
// @run-at       document-start
// @license MIT
// ==/UserScript==

(function () {
  'use strict';

  // 保留原脚本名称和 namespace，便于用户脚本管理器识别为更新。
  const CONFIG = Object.freeze({
    longPressMs: 500,
    longPressTolerancePx: 10,
    directionLockPx: 15,
    targetSpeed: 2,
    baseSensitivity: 0.15, // 原版：起始每 CSS 像素对应 0.15 秒
    maxSensitivity: 1.2, // 原版：每 CSS 像素最高对应 1.2 秒
    accelerationDistancePx: 200, // 原版：滑动 200 CSS 像素后达到最高系数
    minBrightness: 0.1,
    tipHideDelayMs: 450,
    suppressContextMenu: true,
  });

  const CONTROL_SELECTOR = 'button,a,input,select,textarea,[role="button"],'
    + '[role="slider"],[role="menu"],[role="menuitem"],[contenteditable]:not([contenteditable="false"])';
  let gesture = null;
  let longPressTimer = null;
  let hideTimer = null;
  let ui = null;
  let brightness = 1;
  let filterBackup = null;
  let touchStyleBackups = [];
  let blockedClick = null;

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function videosIn(container) {
    if (!container) return [];
    return container.tagName === 'VIDEO' ? [container] : [...container.querySelectorAll('video')];
  }

  function eventPath(event) {
    return event.composedPath ? event.composedPath() : [event.target];
  }

  function isControl(event) {
    return eventPath(event).some(node => node.matches && node.matches(CONTROL_SELECTOR));
  }

  function videoAt(event, point = event) {
    const container = fullscreenElement();
    if (!container || !eventPath(event).includes(container)) return null;
    const candidates = videosIn(container).filter(video => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && point.clientX >= rect.left
        && point.clientX <= rect.right && point.clientY >= rect.top && point.clientY <= rect.bottom;
    });
    const direct = candidates.find(video => eventPath(event).includes(video));
    return direct || candidates.find(video => !video.paused && !video.ended) || candidates[0] || null;
  }

  function prevent(event) {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  function clearLongPress() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function formatTime(value) {
    if (!Number.isFinite(value)) return '--:--';
    const seconds = Math.max(0, Math.floor(value));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
      : `${String(minutes).padStart(2, '0')}:${rest}`;
  }

  function seekRanges(video) {
    // 未加载元数据时 duration 为 NaN；直播可能为 Infinity。
    if (Number.isFinite(video.duration) && video.duration > 0) return [[0, video.duration]];
    if (video.duration !== Infinity) return [];
    const ranges = [];
    const available = video.seekable;
    for (let i = 0; available && i < available.length; i++) {
      const start = available.start(i);
      const end = available.end(i);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) ranges.push([start, end]);
    }
    return ranges;
  }

  function clampToRanges(value, ranges) {
    if (!Number.isFinite(value) || !ranges.length) return null;
    let nearest = ranges[0][0];
    for (const [start, end] of ranges) {
      if (value >= start && value <= end) return value;
      for (const edge of [start, end]) {
        if (Math.abs(edge - value) < Math.abs(nearest - value)) nearest = edge;
      }
    }
    return nearest;
  }

  function seekDelta(dx) {
    // 恢复用户最初版本的完整位移公式，不再按视频宽度或时长缩放。
    // 使用相对起点的位移；回滑可退回原时间，不累计往返路径或事件次数。
    const factor = Math.min(Math.abs(dx) / CONFIG.accelerationDistancePx, 1);
    const sensitivity = CONFIG.baseSensitivity
      + factor * factor * (CONFIG.maxSensitivity - CONFIG.baseSensitivity);
    return dx * sensitivity;
  }

  function createUI() {
    if (ui) return;
    const layer = document.createElement('div');
    layer.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;'
      + 'width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;'
      + 'margin:0!important;padding:0!important;border:0!important;background:transparent!important;'
      + 'pointer-events:none!important;z-index:2147483647!important;overflow:visible!important;';
    // Shadow DOM 避免网页的 div、字体和进度条样式污染提示。
    const root = layer.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { pointer-events:none !important; }
      .shade { position:absolute; inset:0; background:#000; opacity:0; pointer-events:none; }
      .tip { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
        box-sizing:border-box; max-width:90vw; padding:12px 20px; border-radius:10px;
        background:rgba(0,0,0,.75); color:#fff; text-align:center; overflow-wrap:anywhere;
        font:600 clamp(16px,3vw,24px)/1.4 system-ui,sans-serif; pointer-events:none; }
      .bar { height:5px; margin-top:9px; border-radius:3px; overflow:hidden; background:#ffffff45; }
      .fill { height:100%; width:0; background:#1e90ff; }
      [hidden] { display:none !important; }
    `;
    const shade = document.createElement('div');
    shade.className = 'shade';
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    const label = document.createElement('div');
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    bar.appendChild(fill);
    tip.append(label, bar);
    root.append(style, shade, tip);
    ui = { layer, shade, tip, label, bar, fill, container: null, canRender: false };
  }

  function closePopover() {
    if (ui && ui.layer.hidePopover) {
      try { ui.layer.hidePopover(); } catch (_) { /* 尚未打开 */ }
    }
  }

  function mountUI() {
    const container = fullscreenElement();
    if (!container) return false;
    createUI();
    if (ui.container !== container || !ui.layer.isConnected) {
      closePopover();
      ui.layer.removeAttribute('popover');
      ui.container = container;
      ui.canRender = container.tagName !== 'VIDEO';
      // video 是替换元素，不能依靠其子节点显示提示。
      const host = container.tagName === 'VIDEO' ? document.documentElement : container;
      host.appendChild(ui.layer);
      if (typeof ui.layer.showPopover === 'function') {
        ui.layer.setAttribute('popover', 'manual');
        try {
          ui.layer.showPopover(); // 使用顶层显示，支持标准 API 下 video 自身全屏
          ui.canRender = true;
        } catch (_) {
          ui.layer.removeAttribute('popover');
        }
      }
    }
    return ui.canRender;
  }

  function showTip(text, progress = null, color = '#1e90ff', speed = false) {
    clearTimeout(hideTimer);
    if (!mountUI()) return;
    ui.label.textContent = text;
    ui.bar.hidden = progress === null;
    if (progress !== null) {
      ui.fill.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;
      ui.fill.style.background = color;
    }
    ui.tip.style.top = speed ? '8%' : '50%';
    ui.tip.style.transform = speed ? 'translate(-50%,0)' : 'translate(-50%,-50%)';
    ui.tip.hidden = false;
  }

  function hideTip() {
    clearTimeout(hideTimer);
    if (ui) ui.tip.hidden = true;
  }

  function restoreFilter() {
    if (!filterBackup) return;
    const { video, value, priority, applied } = filterBackup;
    // 如果网站在此期间自行改了 filter，不覆盖网站的新值。
    if (video.style.getPropertyValue('filter') === applied) {
      if (value) video.style.setProperty('filter', value, priority);
      else video.style.removeProperty('filter');
    }
    filterBackup = null;
  }

  function updateBrightness(video) {
    const renderable = mountUI();
    if (renderable) {
      restoreFilter();
      ui.shade.style.opacity = String(1 - brightness);
    } else {
      // 老浏览器直接 video 全屏时，用滤镜降级；不要把遮罩插入 video。
      if (filterBackup && filterBackup.video !== video) restoreFilter();
      if (!filterBackup) {
        const computed = getComputedStyle(video).filter;
        filterBackup = { video, value: video.style.getPropertyValue('filter'),
          priority: video.style.getPropertyPriority('filter'),
          base: computed === 'none' ? '' : computed, applied: '' };
      }
      filterBackup.applied = `${filterBackup.base} brightness(${brightness})`.trim();
      video.style.setProperty('filter', filterBackup.applied, 'important');
    }
    showTip(`亮度 ${Math.round(brightness * 100)}%`, brightness, '#ffd700');
  }

  function rememberClick(g) {
    blockedClick = { container: g.container, until: Date.now() + 700,
      x: g.lastX, y: g.lastY };
  }

  function finishGesture(commit = false, immediate = false) {
    clearLongPress();
    const g = gesture;
    gesture = null;
    if (!g) {
      if (immediate) hideTip();
      return;
    }
    if (g.mode) rememberClick(g);
    if (g.speedApplied !== null) {
      try { g.video.playbackRate = g.previousSpeed; } catch (_) { /* 媒体已卸载 */ }
    }
    if (commit && g.mode === 'horizontal' && g.pendingTime !== null && g.video.isConnected) {
      // 直播窗口在滑动期间可能发生变化，松手时重新限制范围。
      const target = clampToRanges(g.pendingTime, seekRanges(g.video));
      if (target !== null) {
        try { g.video.currentTime = target; }
        catch (_) { showTip('当前视频暂时无法跳转'); }
      }
    }
    if (immediate) hideTip();
    else {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideTip, CONFIG.tipHideDelayMs);
    }
  }

  function startLongPress(g) {
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (gesture !== g || g.mode || fullscreenElement() !== g.container
        || !g.video.isConnected || g.video.paused || g.video.ended) return;
      g.previousSpeed = g.video.playbackRate;
      // 无需滑动，长按直接使用指定倍速；松手恢复原速。
      const target = CONFIG.targetSpeed;
      try { g.video.playbackRate = target; }
      catch (_) { return; }
      g.speedApplied = target;
      g.mode = 'speed';
      showTip(`${target}× 倍速播放`, null, '#1e90ff', true);
    }, CONFIG.longPressMs);
  }

  function touchStart(event) {
    if (event.touches.length !== 1) {
      if (gesture) finishGesture(false, true);
      return;
    }
    if (gesture) finishGesture(false, true);
    if (isControl(event)) return;
    const touch = event.touches[0];
    const video = videoAt(event, touch);
    if (!video) return;
    hideTip();
    blockedClick = null;
    const rect = video.getBoundingClientRect();
    gesture = { video, container: fullscreenElement(), identifier: touch.identifier,
      startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastY: touch.clientY,
      startTime: video.currentTime, startBrightness: brightness,
      height: Math.max(1, rect.height),
      mode: null, pendingTime: null, previousSpeed: null, speedApplied: null };
    // 阻止网页在画面区域同时启动自己的长按菜单；单击的默认行为仍可发生。
    event.stopImmediatePropagation();
    startLongPress(gesture);
  }

  function touchMove(event) {
    const g = gesture;
    if (!g) return;
    if (fullscreenElement() !== g.container || !g.video.isConnected || event.touches.length !== 1) {
      finishGesture(false, true);
      return;
    }
    const touch = [...event.touches].find(item => item.identifier === g.identifier);
    if (!touch) { finishGesture(false, true); return; }
    const dx = touch.clientX - g.startX;
    const dy = touch.clientY - g.startY;
    g.lastX = touch.clientX;
    g.lastY = touch.clientY;
    if (Math.hypot(dx, dy) > CONFIG.longPressTolerancePx) clearLongPress();
    if (!g.mode) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= CONFIG.directionLockPx) {
        event.stopImmediatePropagation();
        return;
      }
      g.mode = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
    }
    prevent(event);
    if (g.mode === 'speed') return;
    if (g.mode === 'vertical') {
      brightness = Math.max(CONFIG.minBrightness,
        Math.min(1, g.startBrightness - dy / g.height * (1 - CONFIG.minBrightness)));
      updateBrightness(g.video);
      return;
    }
    const ranges = seekRanges(g.video);
    if (!ranges.length) {
      g.pendingTime = null;
      showTip('当前视频暂不支持进度跳转');
      return;
    }
    const start = ranges[0][0];
    const end = ranges[ranges.length - 1][1];
    const delta = seekDelta(dx);
    g.pendingTime = clampToRanges(g.startTime + delta, ranges);
    if (g.pendingTime === null) return;
    const suffix = Number.isFinite(g.video.duration) ? formatTime(end) : '直播';
    showTip(`${formatTime(g.pendingTime)} / ${suffix}`,
      (g.pendingTime - start) / (end - start));
  }

  function touchEnd(event) {
    const g = gesture;
    if (!g) return;
    const ended = [...event.changedTouches].some(touch => touch.identifier === g.identifier);
    if (!ended) return;
    if (g.mode) prevent(event);
    const valid = fullscreenElement() === g.container && event.touches.length === 0;
    finishGesture(valid);
  }

  function restoreTouchStyles() {
    for (const { node, property, value, priority } of touchStyleBackups) {
      if (node.style.getPropertyValue(property) !== 'none') continue;
      if (value) node.style.setProperty(property, value, priority);
      else node.style.removeProperty(property);
    }
    touchStyleBackups = [];
  }

  function fullscreenChanged() {
    finishGesture(false, true);
    restoreFilter();
    restoreTouchStyles();
    brightness = 1;
    if (ui) {
      ui.shade.style.opacity = '0';
      closePopover();
      ui.layer.remove();
      ui.container = null;
    }
    const container = fullscreenElement();
    if (!container) return;
    const videos = videosIn(container);
    if (!videos.length) return;
    const nodes = [...videos];
    // 播放器的透明覆盖层也需要禁止浏览器接管滚动，但不锁定整页全屏的滚动。
    if (container !== document.documentElement && container !== document.body && !nodes.includes(container)) {
      nodes.push(container);
    }
    for (const node of nodes) {
      const properties = CONFIG.suppressContextMenu
        ? ['touch-action', '-webkit-touch-callout'] : ['touch-action'];
      for (const property of properties) {
        touchStyleBackups.push({ node, property, value: node.style.getPropertyValue(property),
          priority: node.style.getPropertyPriority(property) });
        node.style.setProperty(property, 'none', 'important');
      }
    }
  }

  // document-start + window 捕获阶段，在播放器处理右键事件前拦截。
  window.addEventListener('contextmenu', event => {
    if (!CONFIG.suppressContextMenu) return;
    const g = gesture;
    const inGesture = g && fullscreenElement() === g.container
      && eventPath(event).includes(g.container);
    if (inGesture || videoAt(event)) prevent(event);
  }, { capture: true, passive: false });

  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick']) {
    window.addEventListener(type, event => {
      if (CONFIG.suppressContextMenu && event.button === 2 && videoAt(event)) {
        prevent(event);
      } else if (event.pointerType === 'touch' && !isControl(event) && videoAt(event)) {
        // 部分网站使用 pointerdown/pointerup 实现自己的长按菜单。
        event.stopImmediatePropagation();
      }
    }, { capture: true, passive: false });
  }

  window.addEventListener('click', event => {
    if (!blockedClick || Date.now() > blockedClick.until) return;
    if (event.detail === 0 || isControl(event)) return; // 保留键盘和控件操作
    if (eventPath(event).includes(blockedClick.container)
      && Math.hypot(event.clientX - blockedClick.x, event.clientY - blockedClick.y) < 40) {
      prevent(event);
      blockedClick = null;
    }
  }, { capture: true, passive: false });

  window.addEventListener('touchstart', touchStart, { capture: true, passive: true });
  window.addEventListener('touchmove', touchMove, { capture: true, passive: false });
  window.addEventListener('touchend', touchEnd, { capture: true, passive: false });
  window.addEventListener('touchcancel', event => {
    if (gesture && gesture.mode) prevent(event);
    finishGesture(false, true);
  }, { capture: true, passive: false });
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('webkitfullscreenchange', fullscreenChanged);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finishGesture(false, true);
  });
  window.addEventListener('blur', () => finishGesture(false, true));
  window.addEventListener('pagehide', () => {
    finishGesture(false, true);
    restoreFilter();
    restoreTouchStyles();
  });
  if (fullscreenElement()) fullscreenChanged();
})();
