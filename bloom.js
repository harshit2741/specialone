/* =========================================================
   BLOOM GARDEN — self-contained interaction engine (v2)
   -----------------------------------------------------------
   Vanilla JS. No build step, no framework. Depends only on:
     - MediaPipe Hands (loaded lazily from CDN if not present)
     - MediaPipe Camera Utils (same)
     - Canvas 2D API
     - Web Share API (for WhatsApp sharing, with a download
       fallback where Web Share isn't available)

   Interaction model:
     - Track up to TWO hands.
     - Whichever hand is currently pinching (thumb+index close
       together) is the "growing" hand: its position pulls a
       glowing stem up from one shared root point at the bottom
       of the frame.
     - The OTHER hand (if visible) is the "bloom" hand: how open
       it is controls how large the flower at the tip blooms,
       live, shown as a "Bloom: 0.xx" readout.
     - Releasing the pinch locks that flower in place; the next
       pinch (either hand) starts a new one from the same root.
     - If only one hand is visible, that hand does both jobs at
       once (pinch = grow, hand openness = bloom size), so the
       feature still works with a single hand.
   ========================================================= */
(function () {
  'use strict';

  // ---------------------------------------------------------
  // Config
  // ---------------------------------------------------------
  const BLOOM_TARGET = 10;           // flowers needed to "finish" the garden
  const PINCH_ON_RATIO = 0.55;       // thumb-index distance (relative to hand size) counted as a pinch
  const MIN_KEEP_HEIGHT = 14;        // px — releasing before this discards the barely-there stem
  const MAX_DT = 1 / 20;             // clamp big frame gaps so growth doesn't jump
  const STALE_MS = 250;              // hand data older than this is treated as "hand gone"

  // Neon palette: [core color, glow color]. Warm flame reds/pinks for the
  // bloom, cool blue for the root/stem network — matches a glowing,
  // dark-stage aesthetic rather than flat pastel fills.
  const BLOOM_HUES = [
    ['#FF5A78', '#FF2E55'],  // red-pink
    ['#FF7A5C', '#FF4A2E'],  // flame orange
    ['#FF6FA8', '#FF3D8A'],  // hot pink
    ['#FFB25C', '#FF8A2E'],  // amber gold
    ['#B98CFF', '#7C4FE0'],  // violet
    ['#5CE0FF', '#1FA0E8'],  // cyan
    ['#FFE45C', '#FFB020'],  // sunflower gold
    ['#FF5CE0', '#C61FBF'],  // magenta
    ['#7CFFB2', '#22C97D'],  // mint green
  ];
  const ROOT_COLOR = '#5CFF8E';
  const ROOT_GLOW = '#1FCB63';

  // ---------------------------------------------------------
  // State
  // ---------------------------------------------------------
  const els = {};
  let ctx = null;
  let cssWidth = 0, cssHeight = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  let handsModel = null;
  let cameraUtil = null;
  let mediaStream = null;

  let running = false;
  let rafId = null;
  let lastFrameTime = 0;

  let branches = [];         // every stem+flower grown this session (locked + growing)
  let growingBranch = null;  // the one currently receiving growth, or null
  let particles = [];        // sparkle particles, shared pool
  let plantedCount = 0;

  // Up to two tracked hands this frame, each: {x,y,pinching,pinchStrength,openness,seenAt}
  let handA = null; // the hand currently assigned to "grow"
  let handB = null; // the hand currently assigned to "bloom size"

  let rootPoint = { x: 0, y: 0 };
  let currentBloomReadout = 0;
  let finalSnapshotCanvas = null; // captured once, right before the camera stops at 10 flowers
  let finishing = false;          // true during the "strike a pose" countdown

  // ---------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const randRange = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const ease = {
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    outBack: (t) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function loadFontsOnce() {
    if (document.getElementById('bloomFontLink')) return;
    const link = document.createElement('link');
    link.id = 'bloomFontLink';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&family=Quicksand:wght@500;600;700&display=swap';
    document.head.appendChild(link);
  }

  async function ensureMediaPipe() {
    if (typeof Hands === 'undefined') {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js');
    }
    if (typeof Camera === 'undefined') {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js');
    }
  }

  // ---------------------------------------------------------
  // DOM wiring
  // ---------------------------------------------------------
  function initDom() {
    els.section = document.getElementById('bloom-garden');
    if (!els.section) return false;

    els.intro = $('bloomIntro');
    els.startBtn = $('bloomStartBtn');
    els.error = $('bloomError');

    els.stage = $('bloomStage');
    els.video = $('bloomVideo');
    els.canvas = $('bloomCanvas');
    els.hint = $('bloomHint');
    els.counter = $('bloomCounter');
    els.readout = $('bloomReadout');
    els.captureBtn = $('bloomCaptureBtn');
    els.captureFlash = $('bloomCaptureFlash');
    els.poseOverlay = $('bloomPoseOverlay');
    els.poseText = $('bloomPoseText');
    els.poseCount = $('bloomPoseCount');

    els.complete = $('bloomComplete');
    els.saveBtn = $('bloomSaveBtn');
    els.whatsappBtn = $('bloomWhatsappBtn');
    els.continueLink = $('bloomContinueLink');

    els.drift = $('bloomDrift');

    return !!(els.intro && els.startBtn && els.stage && els.video && els.canvas && els.complete);
  }

  function spawnDecorativePetals() {
    if (!els.drift) return;
    const emojis = ['🌸', '🌷', '🌼'];
    for (let i = 0; i < 6; i++) {
      const p = document.createElement('span');
      p.className = 'bloom-petal-drift';
      p.textContent = pick(emojis);
      p.style.left = randRange(2, 96) + '%';
      p.style.animationDuration = randRange(9, 16) + 's';
      p.style.animationDelay = '-' + randRange(0, 14) + 's';
      p.style.fontSize = randRange(14, 22) + 'px';
      els.drift.appendChild(p);
    }
  }

  function setHint(text) {
    if (els.hint) els.hint.textContent = text;
  }

  function setCounter() {
    if (els.counter) els.counter.textContent = plantedCount + ' / ' + BLOOM_TARGET + ' flowers grown';
  }

  function showError(message) {
    if (!els.error) return;
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function clearError() {
    if (els.error) els.error.hidden = true;
  }

  function setReadout(value, visible) {
    if (!els.readout) return;
    els.readout.textContent = 'Bloom: ' + value.toFixed(2);
    els.readout.classList.toggle('bloom-readout-visible', !!visible);
  }

  // ---------------------------------------------------------
  // Canvas sizing
  // ---------------------------------------------------------
  function resizeCanvas() {
    const rect = els.video.getBoundingClientRect();
    cssWidth = rect.width;
    cssHeight = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    els.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    els.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    ctx = els.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The shared root all stems grow from — bottom-center of the frame.
    rootPoint = { x: cssWidth / 2, y: cssHeight - 6 };
  }

  // ---------------------------------------------------------
  // Branch (stem + flower) factory
  // ---------------------------------------------------------
  function createBranch() {
    const hue = pick(BLOOM_HUES);
    const petalCount = Math.round(randRange(5, 12));
    // Per-petal jitter so no two petals on the same flower are identical —
    // small random offsets to angle, length and width give an organic,
    // hand-grown look instead of a perfectly symmetric mechanical shape.
    const petalJitter = [];
    for (let i = 0; i < petalCount; i++) {
      petalJitter.push({
        angle: randRange(-0.18, 0.18),
        lenMul: randRange(0.82, 1.18),
        widMul: randRange(0.8, 1.25),
      });
    }
    return {
      tipX: rootPoint.x,
      tipY: rootPoint.y,
      height: 0,                 // px from root to tip, drives the stem curve
      bloomSize: 0,               // 0..1, current bloom scale (live while growing)
      lockedBloomSize: 0,         // frozen value once released
      locked: false,
      petalCount,
      petalJitter,
      petalColor: hue[0],
      petalGlow: hue[1],
      doubleRing: Math.random() < 0.5,      // some flowers get a fuller, layered bloom
      rotationOffset: randRange(0, Math.PI * 2),
      spinSpeed: randRange(-0.15, 0.15),
      wobbleSeed: randRange(0, Math.PI * 2),
      curveDir: Math.random() < 0.5 ? -1 : 1,
    };
  }

  // ---------------------------------------------------------
  // Hand tracking callback (MediaPipe Hands, up to 2 hands)
  // ---------------------------------------------------------
  // Per-frame landmark data is noisy — a fingertip can visibly jitter a few
  // pixels frame to frame even with a perfectly still hand, which used to
  // show up as flickery pinch detection and a twitchy bloom size. This is a
  // light exponential smoothing filter over the last frame's values, keyed
  // by detection-order slot, cheap enough to run every frame.
  const SMOOTH_ALPHA = 0.45;
  let smoothSlots = [null, null];
  let prevHandCount = 0;

  function onHandsResults(results) {
    if (!ctx) return;
    const list = results.multiHandLandmarks;
    const now = performance.now();

    if (!list || !list.length) {
      handA = null;
      handB = null;
      smoothSlots = [null, null];
      prevHandCount = 0;
      return;
    }

    if (list.length !== prevHandCount) {
      // Hand count changed since last frame (someone raised/lowered a hand) —
      // drop old smoothing state rather than blending across the jump.
      smoothSlots = [null, null];
    }
    prevHandCount = list.length;

    const toPx = (pt) => ({ x: (1 - pt.x) * cssWidth, y: pt.y * cssHeight });

    const parsed = list.slice(0, 2).map((lm, i) => {
      const thumbTip = toPx(lm[4]);
      const indexTip = toPx(lm[8]);
      const pinkyTip = toPx(lm[20]);
      const wrist = toPx(lm[0]);
      const midMcp = toPx(lm[9]);

      const handSize = Math.hypot(wrist.x - midMcp.x, wrist.y - midMcp.y) || 40;
      const rawPinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y) / handSize;
      // Thumb-to-pinky span is the classic "how open is this hand" measure —
      // it swings through a much wider range than any single fingertip-to-
      // wrist distance, so it converts much more reliably into a visible
      // 0..1 bloom size instead of clustering near one end.
      const rawSpan = Math.hypot(thumbTip.x - pinkyTip.x, thumbTip.y - pinkyTip.y) / handSize;
      const rawX = (thumbTip.x + indexTip.x) / 2;
      const rawY = (thumbTip.y + indexTip.y) / 2;

      const prev = smoothSlots[i];
      const pinchDist = prev ? lerp(prev.pinchDist, rawPinchDist, SMOOTH_ALPHA) : rawPinchDist;
      const span = prev ? lerp(prev.span, rawSpan, SMOOTH_ALPHA) : rawSpan;
      const x = prev ? lerp(prev.x, rawX, SMOOTH_ALPHA) : rawX;
      const y = prev ? lerp(prev.y, rawY, SMOOTH_ALPHA) : rawY;
      smoothSlots[i] = { pinchDist, span, x, y };

      // Closed fist ≈ 0.5–0.9x palm length across thumb-to-pinky; a fully
      // spread hand ≈ 2.2–2.8x. Calibrated against that range so a natural
      // open/close motion actually sweeps the full 0..1 output.
      const openness = clamp((span - 0.9) / (2.4 - 0.9), 0, 1);

      return {
        x,
        y,
        pinching: pinchDist < PINCH_ON_RATIO,
        pinchStrength: clamp(1 - pinchDist / PINCH_ON_RATIO, 0, 1),
        openness,
        seenAt: now,
      };
    });

    // Role assignment: whichever hand is pinching grows the stem; the other
    // (if present) controls bloom size. If both or neither are pinching,
    // just keep the first hand as the "growing" candidate — simple and
    // predictable rather than flickering between roles every frame.
    if (parsed.length === 1) {
      handA = parsed[0];
      handB = null;
    } else {
      const pinchingIdx = parsed.findIndex((h) => h.pinching);
      if (pinchingIdx === -1) {
        handA = parsed[0];
        handB = parsed[1];
      } else {
        handA = parsed[pinchingIdx];
        handB = parsed[1 - pinchingIdx];
      }
    }
  }

  function handFresh(h) {
    return h && performance.now() - h.seenAt < STALE_MS;
  }

  // ---------------------------------------------------------
  // Growth + garden state update (runs every frame, before drawing)
  // ---------------------------------------------------------
  function update(dt) {
    // During the "strike a pose" countdown, freeze all growth input so a
    // stray pinch can't start an 11th flower while we're waiting to capture.
    if (finishing) {
      for (let i = particles.length - 1; i >= 0; i--) {
        updateParticle(particles[i], dt);
        if (particles[i].life <= 0) particles.splice(i, 1);
      }
      return;
    }

    const growHand = handFresh(handA) ? handA : null;
    const sizeHand = handFresh(handB) ? handB : (growHand && !handB ? growHand : null);
    // When there's only one hand total, let it drive bloom size too via its
    // own openness (single-hand fallback), on top of doing the growing.

    const isGrowing = !!(growHand && growHand.pinching);

    if (isGrowing) {
      if (!growingBranch) {
        growingBranch = createBranch();
        branches.push(growingBranch);
      }

      // The stem tip follows the growing hand directly (smoothed), so
      // moving your hand up visibly "pulls" the stem taller in real time.
      const targetX = growHand.x;
      const targetY = growHand.y;
      const followT = clamp(dt * 10, 0, 1);
      growingBranch.tipX = lerp(growingBranch.tipX, targetX, followT);
      growingBranch.tipY = lerp(growingBranch.tipY, targetY, followT);
      growingBranch.height = Math.max(0, rootPoint.y - growingBranch.tipY);

      // Bloom size is live-controlled by the other hand's openness (or the
      // same hand's, if it's the only one visible).
      const targetBloom = sizeHand ? sizeHand.openness : clamp(growHand.pinchStrength, 0, 1);
      growingBranch.bloomSize = lerp(growingBranch.bloomSize, targetBloom, clamp(dt * 6, 0, 1));

      currentBloomReadout = growingBranch.bloomSize;
      setReadout(currentBloomReadout, true);
      setHint('Move your hand to grow the stem \u2014 use your other hand to size the bloom 🌸');
    } else {
      if (growingBranch) {
        if (growingBranch.height < MIN_KEEP_HEIGHT) {
          const idx = branches.indexOf(growingBranch);
          if (idx !== -1) branches.splice(idx, 1);
        } else {
          growingBranch.locked = true;
          growingBranch.lockedBloomSize = Math.max(growingBranch.bloomSize, 0.18);
          spawnSparkles(growingBranch);
          plantedCount++;
          setCounter();
          if (plantedCount >= BLOOM_TARGET) beginFinishSequence();
        }
        growingBranch = null;
      }
      setReadout(currentBloomReadout, false);
      if (plantedCount < BLOOM_TARGET) {
        setHint(handFresh(handA)
          ? 'Pinch your thumb and index finger to grow a stem 🌱'
          : 'Show one hand to the camera to begin 🌱');
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      updateParticle(particles[i], dt);
      if (particles[i].life <= 0) particles.splice(i, 1);
    }
  }

  // ---------------------------------------------------------
  // Sparkle particles
  // ---------------------------------------------------------
  function spawnSparkles(branch) {
    const count = 18;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + randRange(-0.2, 0.2);
      const speed = randRange(20, 52);
      particles.push({
        x: branch.tipX,
        y: branch.tipY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 16,
        life: 1,
        maxLife: randRange(0.7, 1.2),
        size: randRange(2, 4.5),
        color: Math.random() < 0.5 ? '#FFEFD9' : branch.petalColor,
      });
    }
  }

  function updateParticle(p, dt) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 22 * dt;
    p.vx *= 1 - 1.6 * dt;
    p.life -= dt / p.maxLife;
  }

  function drawParticles() {
    for (const p of particles) {
      const a = clamp(p.life, 0, 1);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.5 + a * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------
  // Drawing — neon shared-root garden
  // ---------------------------------------------------------
  function hexToRgba(hex, alpha) {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean, 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
  }

  function lerpHex(hexA, hexB, t) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    const r = Math.round(lerp(a.r, b.r, t));
    const g = Math.round(lerp(a.g, b.g, t));
    const bl = Math.round(lerp(a.b, b.b, t));
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  // The glowing base every stem shares — drawn once per frame.
  function drawRootBase(now) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // soft horizontal root-line along the very bottom, hinting at an
    // underground network connecting every flower to the same source.
    const lineGrad = ctx.createLinearGradient(0, 0, cssWidth, 0);
    lineGrad.addColorStop(0, hexToRgba(ROOT_GLOW, 0));
    lineGrad.addColorStop(0.5, hexToRgba(ROOT_GLOW, 0.55));
    lineGrad.addColorStop(1, hexToRgba(ROOT_GLOW, 0));
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = ROOT_GLOW;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(0, rootPoint.y + 3);
    ctx.lineTo(cssWidth, rootPoint.y + 3);
    ctx.stroke();

    // pulsing core node at the shared root point
    const pulse = 0.7 + 0.3 * Math.sin(now / 400);
    const r = 5 + pulse * 3;
    const grad = ctx.createRadialGradient(rootPoint.x, rootPoint.y, 0, rootPoint.x, rootPoint.y, r * 4);
    grad.addColorStop(0, hexToRgba(ROOT_COLOR, 0.9));
    grad.addColorStop(1, hexToRgba(ROOT_COLOR, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(rootPoint.x, rootPoint.y, r * 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#EAFFEF';
    ctx.beginPath();
    ctx.arc(rootPoint.x, rootPoint.y, r * 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // Returns the stem's quadratic control point, so branches drift and
  // curve slightly rather than growing as perfectly straight lines.
  function stemControlPoint(branch) {
    const midX = (rootPoint.x + branch.tipX) / 2;
    const bow = branch.curveDir * Math.min(branch.height * 0.28, 40);
    return { x: midX + bow, y: (rootPoint.y + branch.tipY) / 2 };
  }

  function drawStem(branch, now) {
    if (branch.height < 2) return;
    const ctrl = stemControlPoint(branch);
    const wobble = branch.locked ? Math.sin(now / 900 + branch.wobbleSeed) * 1.5 : 0;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = ROOT_GLOW;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = ROOT_COLOR;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rootPoint.x, rootPoint.y);
    ctx.quadraticCurveTo(ctrl.x + wobble, ctrl.y, branch.tipX + wobble, branch.tipY);
    ctx.stroke();

    // a couple of small glowing diamond nodes along the stem
    const nodeCount = branch.height > 60 ? 2 : 1;
    for (let i = 1; i <= nodeCount; i++) {
      const t = i / (nodeCount + 1);
      const mt = 1 - t;
      const nx = mt * mt * rootPoint.x + 2 * mt * t * (ctrl.x + wobble) + t * t * (branch.tipX + wobble);
      const ny = mt * mt * rootPoint.y + 2 * mt * t * ctrl.y + t * t * branch.tipY;
      drawDiamondNode(nx, ny, 3.4);
    }

    ctx.restore();
  }

  function drawDiamondNode(x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.shadowColor = ROOT_COLOR;
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#D9FFE0';
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.restore();
  }

  // The glowing flame-like bloom at a branch's tip.
  // Draws one petal at index i around a branch's tip. baseLen/baseWid set
  // the ring's overall size; jitter + a color sweep across the ring keep
  // every flower from looking like a stamped-out copy of the last one.
  function drawPetal(branch, i, spin, baseLen, baseWid, alphaMul) {
    const jitter = branch.petalJitter[i % branch.petalJitter.length];
    const angle = branch.rotationOffset + spin + jitter.angle + (i / branch.petalCount) * Math.PI * 2;
    const len = baseLen * jitter.lenMul;
    const wid = baseWid * jitter.widMul;

    // Smooth back-and-forth sweep between the two branch hues instead of a
    // single flat color, so each bloom reads as gradient-lit, not painted.
    const sweep = 0.5 - 0.5 * Math.cos((i / branch.petalCount) * Math.PI * 2);
    const strokeColor = lerpHex(branch.petalColor, branch.petalGlow, sweep * 0.6);

    ctx.save();
    ctx.rotate(angle);

    ctx.shadowColor = branch.petalGlow;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(wid, -len * 0.55, 0, -len);
    ctx.quadraticCurveTo(-wid, -len * 0.55, 0, 0);
    ctx.stroke();

    // faint fill so petals read as flame-like shapes, not just outlines
    ctx.fillStyle = hexToRgba(branch.petalColor, 0.16 * alphaMul);
    ctx.fill();

    ctx.restore();
  }

  function drawBloom(branch, now) {
    const size = branch.locked ? branch.lockedBloomSize : branch.bloomSize;
    if (size <= 0.02) {
      // still just a glowing bud
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hexToRgba(branch.petalColor, 0.9);
      ctx.shadowColor = branch.petalGlow;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(branch.tipX, branch.tipY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    const spin = branch.locked ? now / 1000 * branch.spinSpeed : 0;
    const petalLen = 14 + size * 26;
    const petalWid = 5 + size * 7;

    ctx.save();
    ctx.translate(branch.tipX, branch.tipY);
    ctx.globalCompositeOperation = 'lighter';

    // outer glow halo
    const glowR = petalLen * 1.3;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
    glow.addColorStop(0, hexToRgba(branch.petalGlow, 0.4 * size));
    glow.addColorStop(1, hexToRgba(branch.petalGlow, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, glowR, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < branch.petalCount; i++) {
      drawPetal(branch, i, spin, petalLen, petalWid, 1);
    }

    // Fuller flowers get a second, smaller inner ring offset between the
    // outer petals — reads as a layered bloom rather than a flat pinwheel.
    if (branch.doubleRing && size > 0.5) {
      const innerLen = petalLen * 0.55;
      const innerWid = petalWid * 0.7;
      for (let i = 0; i < branch.petalCount; i++) {
        drawPetal(branch, i, spin + Math.PI / branch.petalCount, innerLen, innerWid, 0.7);
      }
    }

    // bright core
    ctx.shadowColor = '#FFF3D9';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#FFF6E3';
    ctx.beginPath();
    ctx.arc(0, 0, 3 + size * 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawBranch(branch, now) {
    drawStem(branch, now);
    drawBloom(branch, now);
  }

  // ---------------------------------------------------------
  // Hand skeleton overlay — small glowing dots/lines so the tracked
  // hand itself reads as part of the "tech garden" visual, echoing the
  // reference look rather than an invisible tracker.
  // ---------------------------------------------------------
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];

  function drawHandSkeleton(results) {
    const list = results.multiHandLandmarks;
    if (!list || !list.length) return;
    const toPx = (pt) => ({ x: (1 - pt.x) * cssWidth, y: pt.y * cssHeight });

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const lm of list) {
      const pts = lm.map(toPx);

      ctx.strokeStyle = 'rgba(180, 220, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.shadowColor = '#8FDFFF';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();

      ctx.fillStyle = 'rgba(220, 240, 255, 0.55)';
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  let lastHandResults = null;

  // ---------------------------------------------------------
  // Main render pass
  // ---------------------------------------------------------
  function render(now) {
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    drawRootBase(now);
    for (const b of branches) drawBranch(b, now);
    drawParticles();
    if (lastHandResults) drawHandSkeleton(lastHandResults);
  }

  // Wrap the results handler so render() can also draw the skeleton
  // without MediaPipe needing to know about rendering at all.
  function onHandsResultsWrapped(results) {
    lastHandResults = results;
    onHandsResults(results);
  }

  // ---------------------------------------------------------
  // rAF loop
  // ---------------------------------------------------------
  function loop(ts) {
    if (!running) return;
    if (!lastFrameTime) lastFrameTime = ts;
    const dt = Math.min((ts - lastFrameTime) / 1000, MAX_DT);
    lastFrameTime = ts;

    update(dt);
    render(ts);

    rafId = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------
  // Camera + MediaPipe lifecycle
  // ---------------------------------------------------------
  async function startExperience() {
    clearError();
    els.startBtn.disabled = true;
    els.startBtn.textContent = 'Opening camera\u2026';

    try {
      await ensureMediaPipe();

      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' } },
        audio: false,
      });

      els.video.srcObject = mediaStream;
      await new Promise((resolve) => {
        els.video.onloadedmetadata = () => {
          els.video.play().then(resolve).catch(resolve);
        };
      });

      els.intro.hidden = true;
      els.stage.hidden = false;
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);

      handsModel = new Hands({
        locateFile: (file) => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/' + file,
      });
      handsModel.setOptions({
        maxNumHands: 2,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
      handsModel.onResults(onHandsResultsWrapped);

      cameraUtil = new Camera(els.video, {
        onFrame: async () => {
          try { await handsModel.send({ image: els.video }); } catch (e) { /* ignore transient frame errors */ }
        },
        width: 384,
        height: 512,
      });
      await cameraUtil.start();

      running = true;
      lastFrameTime = 0;
      rafId = requestAnimationFrame(loop);
    } catch (err) {
      stopCamera();
      els.stage.hidden = true;
      els.intro.hidden = false;
      els.startBtn.disabled = false;
      els.startBtn.textContent = 'Start Growing';
      showError('We couldn\u2019t reach your camera. Please allow camera access and try again.');
      // eslint-disable-next-line no-console
      console.error('[BloomGarden]', err);
    }
  }

  function stopCamera() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    window.removeEventListener('resize', resizeCanvas);

    if (cameraUtil && typeof cameraUtil.stop === 'function') {
      try { cameraUtil.stop(); } catch (e) { /* noop */ }
    }
    cameraUtil = null;

    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  const POSE_MESSAGES = [
    '✨ Give me your favorite pose!',
    '🌸 Strike a pose with your garden!',
    '💫 Smile — this one\u2019s a keeper!',
  ];

  function beginFinishSequence() {
    if (finishing) return;
    finishing = true;
    setReadout(currentBloomReadout, false);
    if (els.poseOverlay) {
      if (els.poseText) els.poseText.textContent = pick(POSE_MESSAGES);
      els.poseOverlay.hidden = false;
    }
    runPoseCountdown(8);
  }

  function runPoseCountdown(count) {
    if (els.poseCount) els.poseCount.textContent = String(count);
    if (count > 0) {
      setTimeout(() => runPoseCountdown(count - 1), 1000);
    } else {
      if (els.poseCount) els.poseCount.textContent = '📸';
      setTimeout(capturePoseAndFinish, 380);
    }
  }

  function capturePoseAndFinish() {
    flashCapture();
    finalSnapshotCanvas = composeSnapshot();
    if (els.poseOverlay) els.poseOverlay.hidden = true;
    finishing = false;
    stopCamera();
    els.stage.hidden = true;
    els.complete.hidden = false;
  }

  // ---------------------------------------------------------
  // Screenshot capture — composites the mirrored camera frame with
  // the current neon overlay into one image, matching exactly what's
  // visible on screen.
  // ---------------------------------------------------------
  function drawVideoCover(targetCtx, video, dw, dh) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(dw / vw, dh / vh);
    const sw = dw / scale, sh = dh / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    targetCtx.save();
    targetCtx.translate(dw, 0);
    targetCtx.scale(-1, 1); // mirror to match the on-screen preview
    targetCtx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    targetCtx.restore();
  }

  function composeSnapshot() {
    const off = document.createElement('canvas');
    off.width = els.canvas.width;
    off.height = els.canvas.height;
    const octx = off.getContext('2d');
    drawVideoCover(octx, els.video, off.width, off.height);
    octx.drawImage(els.canvas, 0, 0);
    return off;
  }

  // Picks the right image source depending on where the click came from:
  // while the camera is live (the floating capture button, mid-session)
  // we composite a fresh frame; once it's finished and the camera has
  // stopped, we fall back to the snapshot saved at that exact moment.
  function getSnapshotCanvas() {
    if (running && els.video.videoWidth) {
      return composeSnapshot();
    }
    return finalSnapshotCanvas;
  }

  function flashCapture() {
    if (!els.captureFlash) return;
    els.captureFlash.classList.remove('bloom-flash-active');
    // force reflow so the animation can retrigger on repeated taps
    void els.captureFlash.offsetWidth;
    els.captureFlash.classList.add('bloom-flash-active');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function handleSavePhoto() {
    const off = getSnapshotCanvas();
    if (!off) return; // nothing to capture yet
    flashCapture();
    off.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, 'bloom-garden.png');
    }, 'image/png');
  }

  async function handleShareWhatsapp() {
    const off = getSnapshotCanvas();
    if (!off) return;
    off.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], 'bloom-garden.png', { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: 'My Bloom Garden',
            text: 'Look what I grew in my birthday garden! 🌸',
          });
          return;
        } catch (e) {
          // user cancelled the share sheet, or it failed — fall through to the manual fallback below
        }
      }

      // Fallback for browsers without Web Share (mostly desktop): download
      // the image and open WhatsApp so it can be attached manually.
      downloadBlob(blob, 'bloom-garden.png');
      window.open(
        'https://wa.me/?text=' + encodeURIComponent('Look what I grew in my birthday garden! 🌸 (photo saved to downloads)'),
        '_blank'
      );
    }, 'image/png');
  }

  // ---------------------------------------------------------
  // Init
  // ---------------------------------------------------------
  function init() {
    if (!initDom()) return; // section not present on this page — do nothing
    loadFontsOnce();
    spawnDecorativePetals();
    setCounter();

    els.startBtn.addEventListener('click', startExperience);
    if (els.captureBtn) els.captureBtn.addEventListener('click', handleSavePhoto);
    if (els.saveBtn) els.saveBtn.addEventListener('click', handleSavePhoto);
    if (els.whatsappBtn) els.whatsappBtn.addEventListener('click', handleShareWhatsapp);
    if (els.continueLink) {
      els.continueLink.addEventListener('click', () => {
        if (typeof window.onBloomGardenSelfie === 'function') {
          window.onBloomGardenSelfie();
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Minimal public surface, in case a host page wants to reset the garden
  // (e.g. re-entering the section) without a full page reload.
  window.BloomGarden = {
    reset: function () {
      stopCamera();
      branches = [];
      growingBranch = null;
      particles = [];
      plantedCount = 0;
      handA = null;
      handB = null;
      finalSnapshotCanvas = null;
      finishing = false;
      if (els.poseOverlay) els.poseOverlay.hidden = true;
      if (els.counter) setCounter();
      if (els.complete) els.complete.hidden = true;
      if (els.stage) els.stage.hidden = true;
      if (els.intro) els.intro.hidden = false;
      if (els.startBtn) {
        els.startBtn.disabled = false;
        els.startBtn.textContent = 'Start Growing';
      }
    },
  };
})();
