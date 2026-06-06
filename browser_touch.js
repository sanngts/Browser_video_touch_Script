// ==UserScript==
// @name         视频触屏滑动脚本v1.1
// @namespace    http://tampermonkey.net/
// @version      1.1.1
// @description  全屏下左右滑动可以拖动视频进度条，上下滑动调节屏幕亮度
// @author       sanngtsu
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const BASE_SENSITIVITY = 0.15;
  const MAX_SENSITIVITY = 1.2;

  let isTouching = false;
  let startX = 0, startY = 0;
  let startVideoTime = 0;
  let currentVideo = null;
  let hasMoved = false;
  let tipElement = null;
  let progressBarOuter = null;
  let progressBarInner = null;

  // 亮度相关变量
  let brightnessOverlay = null;
  let currentBrightness = 1.0; // 1.0 = 100%亮度
  let startBrightness = 1.0;
  let swipeMode = null; // 'horizontal' | 'vertical' | 'longpress_speed' | null
  const BRIGHTNESS_STEP = 0.008; // 每次滑动的亮度变化量

  // 长按倍速相关变量
  let touchStartTime = 0;
  let longPressSpeedActive = false;   // 是否已触发长按倍速
  let previousSpeed = 1.0;            // 记录触发前的播放速率
  const LONG_PRESS_DURATION = 500;    // 长按阈值：0.5秒
  const SPEED_SWIPE_MIN = 10;         // 轻微滑动最小距离(px)
  const SPEED_SWIPE_MAX = 80;         // 轻微滑动最大距离(px)，超过则为普通进度滑动
  const TARGET_SPEED = 2.0;           // 目标倍速

  function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function createTip() {
    if (tipElement) return;

    tipElement = document.createElement('div');
    tipElement.style.cssText = `
      position: absolute;
      z-index: 99999999;
      background: rgba(0,0,0,0.7);
      color: #fff;
      padding: 14px 24px;
      border-radius: 10px;
      font-size: 24px;
      font-weight: bold;
      display: none;
      pointer-events: none;
      white-space: nowrap;
      text-align: center;
      min-width: 180px;
    `;

    progressBarOuter = document.createElement('div');
    progressBarOuter.style.cssText = `
      width: 100%;
      height: 6px;
      background: rgba(255,255,255,0.3);
      border-radius: 3px;
      margin-top: 10px;
      overflow: hidden;
    `;

    progressBarInner = document.createElement('div');
    progressBarInner.style.cssText = `
      height: 100%;
      width: 0%;
      background: #1E90FF;
      border-radius: 3px;
      transition: width 0.08s linear;
    `;

    progressBarOuter.appendChild(progressBarInner);
    tipElement.appendChild(progressBarOuter);
    document.body.appendChild(tipElement);
  }

  // 创建亮度覆盖层（挂载到全屏容器上）
  function createBrightnessOverlay() {
    if (brightnessOverlay) return;
    brightnessOverlay = document.createElement('div');
    brightnessOverlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 99999998;
      pointer-events: none;
      background: #000;
      opacity: 0;
      transition: opacity 0.1s ease;
    `;
    document.body.appendChild(brightnessOverlay);
  }

  // 将亮度覆盖层移动到全屏容器内
  function ensureOverlayInFullscreen() {
    if (!brightnessOverlay) createBrightnessOverlay();
    const container = document.fullscreenElement;
    if (container && brightnessOverlay.parentElement !== container) {
      container.appendChild(brightnessOverlay);
    }
  }

  // 更新亮度显示
  function updateBrightnessDisplay() {
    if (!brightnessOverlay) createBrightnessOverlay();
    ensureOverlayInFullscreen();
    const opacity = 1 - currentBrightness; // 亮度越低，黑色透明度越高
    brightnessOverlay.style.opacity = Math.max(0, Math.min(1, opacity)).toString();
  }

  // 清除亮度遮罩（退出全屏时调用）
  function clearBrightnessOverlay() {
    if (brightnessOverlay) {
      brightnessOverlay.style.opacity = '0';
      if (brightnessOverlay.parentElement !== document.body) {
        document.body.appendChild(brightnessOverlay);
      }
    }
    currentBrightness = 1.0;
    startBrightness = 1.0;
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function showTip(video, current, total) {
    if (!tipElement) createTip();
    const container = document.fullscreenElement || document.documentElement;
    if (tipElement.parentElement !== container) container.appendChild(tipElement);

    tipElement.textContent = `${formatTime(current)} / ${formatTime(total)}`;
    tipElement.appendChild(progressBarOuter);

    const percent = (current / total) * 100;
    progressBarInner.style.width = percent + "%";

    tipElement.style.left = '50%';
    tipElement.style.top = '50%';
    tipElement.style.transform = 'translate(-50%, -50%)';
    tipElement.style.display = 'block';
  }

  // 显示亮度提示
  function showBrightnessTip() {
    if (!tipElement) createTip();
    const container = document.fullscreenElement || document.documentElement;
    if (tipElement.parentElement !== container) container.appendChild(tipElement);

    // 使用亮度图标和百分比
    const icon = currentBrightness > 0.7 ? '☀️' : (currentBrightness > 0.3 ? '🌓' : '🌙');
    tipElement.textContent = `${icon} 亮度 ${Math.round(currentBrightness * 100)}%`;
    tipElement.appendChild(progressBarOuter);

    progressBarInner.style.width = (currentBrightness * 100) + "%";
    progressBarInner.style.background = currentBrightness > 0.5 ? '#FFD700' : '#FFA500';

    tipElement.style.left = '50%';
    tipElement.style.top = '50%';
    tipElement.style.transform = 'translate(-50%, -50%)';
    tipElement.style.display = 'block';
  }

  function hideTip() {
    if (tipElement) tipElement.style.display = 'none';
  }

  function getActiveVideo() {
    const videos = document.querySelectorAll('video');
    for (let v of videos) if (!v.paused && !v.ended) return v;
    return videos[0] || null;
  }

  // 显示倍速提示
  function showSpeedTip(speed) {
    if (!tipElement) createTip();
    const container = document.fullscreenElement || document.documentElement;
    if (tipElement.parentElement !== container) container.appendChild(tipElement);

    tipElement.textContent = `${speed}x 倍速播放`;
    tipElement.appendChild(progressBarOuter);

    progressBarInner.style.width = ((speed / 3) * 100) + "%";
    progressBarInner.style.background = '#1E90FF';

    tipElement.style.left = '50%';
    tipElement.style.top = '8%';
    tipElement.style.transform = 'translate(-50%, 0)';
    tipElement.style.display = 'block';
  }

  // 监听全屏变化，退出全屏时清除亮度遮罩
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      clearBrightnessOverlay();
    }
  });

  // webkit 前缀兼容（Safari 等）
  document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement) {
      clearBrightnessOverlay();
    }
  });

  document.addEventListener('touchstart', e => {
    if (!isFullscreen()) return;
    if (e.touches.length !== 1) return;
    currentVideo = getActiveVideo();
    if (!currentVideo) return;

    isTouching = true;
    hasMoved = false;
    swipeMode = null;
    longPressSpeedActive = false;
    touchStartTime = Date.now();
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startVideoTime = currentVideo.currentTime;
    startBrightness = currentBrightness;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!isFullscreen() || !isTouching || !currentVideo) return;
    if (e.touches.length !== 1) return;

    const nowX = e.touches[0].clientX;
    const nowY = e.touches[0].clientY;
    const diffX = Math.abs(nowX - startX);
    const diffY = Math.abs(nowY - startY);
    const elapsed = Date.now() - touchStartTime;
    const moveX = nowX - startX; // 正值=向右，负值=向左

    // 判断滑动方向（需要移动超过阈值才确定方向）
    const LOCK_THRESHOLD = 15;
    if (!swipeMode) {
      if (diffX > LOCK_THRESHOLD || diffY > LOCK_THRESHOLD) {
        // ---- 长按1秒 + 轻微向右滑动 → 触发二倍速 ----
        if (elapsed >= LONG_PRESS_DURATION && moveX > 0 && diffX >= SPEED_SWIPE_MIN && diffX <= SPEED_SWIPE_MAX && diffX > diffY) {
          swipeMode = 'longpress_speed';
          longPressSpeedActive = true;
          previousSpeed = currentVideo.playbackRate;
          currentVideo.playbackRate = TARGET_SPEED;
          hasMoved = true;
          e.preventDefault();
          showSpeedTip(TARGET_SPEED);
          return;
        }
        // 普通方向判断
        swipeMode = diffX >= diffY ? 'horizontal' : 'vertical';
      } else {
        return; // 未确定方向时不响应
      }
    }

    hasMoved = true;
    e.preventDefault();

    if (swipeMode === 'longpress_speed') {
      // 长按倍速模式下：仅显示提示，不做额外操作
      // （如需滑动调节倍速大小，可在此扩展）
      return;
    } else if (swipeMode === 'vertical') {
      // ===== 垂直滑动：调节亮度 =====
      const moveY = startY - nowY; // 向上滑为正（增加亮度）
      const brightnessChange = moveY * BRIGHTNESS_STEP;
      currentBrightness = Math.max(0.1, Math.min(1.0, startBrightness + brightnessChange));
      updateBrightnessDisplay();
      showBrightnessTip();
    } else {
      // ===== 水平滑动：调节视频进度 =====
      const distance = Math.abs(nowX - startX);
      const factor = Math.min(distance / 200, 1);
      const sensitivity = BASE_SENSITIVITY + (factor * factor) * (MAX_SENSITIVITY - BASE_SENSITIVITY);

      const timeChange = moveX * sensitivity;

      let newTime = startVideoTime + timeChange;
      newTime = Math.max(0, Math.min(newTime, currentVideo.duration));
      currentVideo.currentTime = newTime;

      showTip(currentVideo, newTime, currentVideo.duration);
    }
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (!isFullscreen() || !isTouching) return;

    // 长按倍速结束：恢复原播放速率
    if (longPressSpeedActive && currentVideo) {
      currentVideo.playbackRate = previousSpeed;
      longPressSpeedActive = false;
    }

    if (hasMoved) {
      e.preventDefault();
      e.stopPropagation();
    }
    setTimeout(() => hideTip(), 150);

    isTouching = false;
    currentVideo = null;
    hasMoved = false;
    swipeMode = null;
  });

  document.addEventListener('touchcancel', () => {
    if (!isFullscreen()) return;
    // 长按倍速结束：恢复原播放速率
    if (longPressSpeedActive && currentVideo) {
      currentVideo.playbackRate = previousSpeed;
      longPressSpeedActive = false;
    }
    hideTip();
    isTouching = false;
    currentVideo = null;
    hasMoved = false;
    swipeMode = null;
  });
})();