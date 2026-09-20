/* LUMÉ: весь сжатый фильм до скролла, ограниченное окно декодированных кадров. */
const $ = s => document.querySelector(s);
const FRAME_COUNT = 301;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobileFilm = matchMedia('(pointer: coarse), (max-width: 767px)').matches;
const JUMP = new URLSearchParams(location.search).get('jump');
if (JUMP !== null) history.scrollRestoration = 'manual';
const filmEl = $('#film'), stageEl = $('#stage'), hdr = $('#hdr');
const screenCv = $('#screen'), sctx = screenCv.getContext('2d', { alpha: false });
const ambCv = $('#ambient'), actx = ambCv.getContext('2d');
const beats = [...document.querySelectorAll('.beat')].map(el => ({
  el, in: +el.dataset.in, peak: +el.dataset.peak, out: +el.dataset.out,
  dim: el.dataset.dim === undefined ? 1 : +el.dataset.dim,
  hero: el.classList.contains('hero')
}));
const chapters = ['Chapitre 01 · Crème', 'Chapitre 02 · Poudre', 'Chapitre 03 · Soie', 'Chapitre 04 · Goutte', 'Chapitre 05 · Atelier'];
let lenis = null;
if (!mobileFilm && !reduceMotion && JUMP === null && typeof Lenis !== 'undefined') {
  lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
  const smoothTick = t => { lenis.raf(t); requestAnimationFrame(smoothTick); };
  requestAnimationFrame(smoothTick);
}

const cache = new Map(), pending = new Map(), failures = new Set();
const packs = new Map();
const CACHE_LIMIT = mobileFilm ? 16 : 32, LOAD_LIMIT = mobileFilm ? 2 : 3;
const AHEAD = mobileFilm ? 8 : 12, BEHIND = mobileFilm ? 3 : 6;
let frameQueue = [], cacheCenter = 0, direction = 1, frameGeneration = 0;
let portraitFrames = false, displayed = -1, displayedSource = null;
let CW = 0, CH = 0, currentFrame = 0, prog = 0, rafId = 0, lastTick = 0;
let engineStarted = false, filmVisible = true, ambientDirty = false;
let bootTimer = 0, fontsDone = false, bootDismissed = false;
document.fonts.ready.then(() => { fontsDone = true; });
const DPR = Math.min(devicePixelRatio || 1, mobileFilm ? 1.25 : 1.5);
const releaseFrame = frame => {
  if (typeof frame.close === 'function') frame.close();
  else frame.removeAttribute('src');
};
const packProfile = () => portraitFrames ? 'portrait' : 'wide';

async function readFramePack(blob) {
  const headerSize = 12 + (FRAME_COUNT + 1) * 4;
  const header = await blob.slice(0, headerSize).arrayBuffer();
  if (header.byteLength !== headerSize) throw new Error('incomplete film');
  const view = new DataView(header);
  const magic = String.fromCharCode(...new Uint8Array(header, 0, 8));
  if (magic !== 'LUMEF001' || view.getUint32(8, true) !== FRAME_COUNT) throw new Error('invalid film');
  const offsets = Array.from({ length: FRAME_COUNT + 1 }, (_, i) => view.getUint32(12 + i * 4, true));
  if (offsets[0] !== headerSize || offsets[FRAME_COUNT] !== blob.size ||
      offsets.some((n, i) => i && n <= offsets[i - 1])) throw new Error('invalid frame offsets');
  return offsets;
}

function getPack() {
  const profile = packProfile();
  if (packs.has(profile)) return packs.get(profile);
  const pack = { blob: null, offsets: null, progress: 0, error: null };
  packs.set(profile, pack);
  pack.promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`media/film-${profile}-v3.bin`, { signal: controller.signal });
      if (!response.ok) throw new Error(`film ${response.status}`);
      let blob;
      if (response.body && response.body.getReader) {
        const total = Number(response.headers.get('Content-Length'));
        const reader = response.body.getReader(), chunks = [];
        let received = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value); received += value.byteLength;
          if (total > 0) pack.progress = Math.min(.98, received / total);
        }
        blob = new Blob(chunks);
      } else blob = await response.blob();
      const offsets = await readFramePack(blob);
      pack.offsets = offsets; pack.blob = blob; pack.progress = 1;
      if (profile === packProfile()) {
        ensureFrames(cacheCenter);
        wakeFilm();
      }
    } catch (error) {
      pack.error = error;
    } finally { clearTimeout(timeout); }
  })();
  return pack;
}

function wakeFilm() {
  if (engineStarted && !document.hidden && !rafId) rafId = requestAnimationFrame(tick);
}
function trimCache() {
  const stale = [...cache.keys()].sort((a, b) => Math.abs(b - cacheCenter) - Math.abs(a - cacheCenter));
  for (const i of stale) {
    if (cache.size <= CACHE_LIMIT) break;
    releaseFrame(cache.get(i));
    cache.delete(i);
  }
}
function resetFrames() {
  frameGeneration++;
  frameQueue = [];
  for (const request of pending.values()) request.cancelled = true;
  for (const frame of cache.values()) releaseFrame(frame);
  cache.clear(); failures.clear();
  displayed = -1; displayedSource = null;
}
async function decodeFrame(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch (_) { /* Safari: резерв через decode(). */ }
  }
  const url = URL.createObjectURL(blob), img = new Image();
  img.decoding = 'async';
  try {
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}
async function loadFrame(i, request) {
  let frame = null;
  try {
    const { blob, offsets } = request.pack;
    frame = await decodeFrame(blob.slice(offsets[i], offsets[i + 1], 'image/webp'));
    if (request.generation !== frameGeneration || request.cancelled || Math.abs(i - cacheCenter) > CACHE_LIMIT) {
      releaseFrame(frame);
      return;
    }
    cache.set(i, frame);
    trimCache();
    wakeFilm(); // Точный кадр заменяет временный даже после остановки пальца.
  } catch (_) {
    if (!request.cancelled && request.generation === frameGeneration) failures.add(i);
  } finally {
    pending.delete(i);
    pumpFrames();
    if (filmVisible) wakeFilm();
  }
}
function pumpFrames() {
  if (document.hidden || !filmVisible) return;
  const pack = getPack();
  if (!pack.blob) return;
  while (pending.size < LOAD_LIMIT && frameQueue.length) {
    const i = frameQueue.shift();
    if (cache.has(i) || pending.has(i) || failures.has(i)) continue;
    const request = { pack, generation: frameGeneration, cancelled: false };
    pending.set(i, request);
    loadFrame(i, request);
  }
}
function ensureFrames(center) {
  if (center !== cacheCenter) direction = center > cacheCenter ? 1 : -1;
  cacheCenter = center;
  const wanted = [center];
  for (let distance = 1; distance <= AHEAD; distance++) {
    wanted.push(center + distance * direction);
    if (distance <= BEHIND) wanted.push(center - distance * direction);
  }
  frameQueue = wanted.filter(i => i >= 0 && i < FRAME_COUNT && !cache.has(i) && !pending.has(i) && !failures.has(i));
  pumpFrames();
}
function nearestFrame(idx) {
  let closest = -1;
  for (const i of cache.keys()) if (closest < 0 || Math.abs(i - idx) < Math.abs(closest - idx)) closest = i;
  return closest < 0 ? null : { index: closest, source: cache.get(closest) };
}
function drawFrame(idx, force = false) {
  const nearest = nearestFrame(idx);
  if (!nearest || (!force && nearest.source === displayedSource)) return;
  const src = nearest.source, iw = src.width, ih = src.height;
  const scale = Math.max(CW / iw, CH / ih);
  sctx.drawImage(src, (CW - iw * scale) / 2, (CH - ih * scale) / 2, iw * scale, ih * scale);
  displayed = nearest.index;
  displayedSource = src;
}
function sizeCanvases() {
  const width = stageEl.clientWidth, height = stageEl.clientHeight;
  if (!width || !height || (width === CW && height === CH)) return false;
  let previous = null;
  if (displayed >= 0) {
    previous = document.createElement('canvas');
    previous.width = screenCv.width; previous.height = screenCv.height;
    previous.getContext('2d').drawImage(screenCv, 0, 0);
  }
  CW = width; CH = height;
  const portrait = mobileFilm && CW <= 540 && CW / CH <= 2 / 3;
  const profileChanged = portrait !== portraitFrames;
  if (profileChanged) { portraitFrames = portrait; resetFrames(); }
  screenCv.width = Math.round(CW * DPR); screenCv.height = Math.round(CH * DPR);
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (previous) {
    const scale = Math.max(CW / previous.width, CH / previous.height);
    sctx.drawImage(previous, (CW - previous.width * scale) / 2, (CH - previous.height * scale) / 2, previous.width * scale, previous.height * scale);
    previous.width = previous.height = 0;
  }
  if (!mobileFilm && !reduceMotion) {
    ambCv.width = Math.round(CW * DPR); ambCv.height = Math.round(CH * DPR);
    actx.setTransform(DPR, 0, 0, DPR, 0, 0);
    makeParts();
  }
  drawFrame(Math.round(currentFrame), true);
  if (engineStarted) ensureFrames(Math.round(currentFrame));
  if (engineStarted && profileChanged) monitorFilmLoading();
  return true;
}

let sprite = null, parts = [];
function makeParts() {
  if (!sprite) {
    sprite = document.createElement('canvas'); sprite.width = sprite.height = 32;
    const c = sprite.getContext('2d'), gradient = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,232,180,1)'); gradient.addColorStop(.35, 'rgba(232,196,120,.55)'); gradient.addColorStop(1, 'rgba(232,196,120,0)');
    c.fillStyle = gradient; c.fillRect(0, 0, 32, 32);
  }
  parts = Array.from({ length: 64 }, () => ({ x: Math.random() * CW, y: Math.random() * CH,
    z: .3 + Math.random() * .7, ph: Math.random() * Math.PI * 2, vx: .08 + Math.random() * .22, vy: -(.05 + Math.random() * .18) }));
}
function drawAmbient(now, alpha) {
  if (mobileFilm || reduceMotion) return;
  if (alpha <= .005) {
    if (ambientDirty) actx.clearRect(0, 0, CW, CH);
    ambientDirty = false;
    return;
  }
  actx.clearRect(0, 0, CW, CH); ambientDirty = true;
  for (const p of parts) {
    p.x += p.vx * p.z; p.y += p.vy * p.z;
    if (p.x > CW + 20) p.x = -20; if (p.y < -20) p.y = CH + 20;
    const tw = .5 + .5 * Math.sin(now * .0016 + p.ph), size = 5 + 15 * p.z * tw;
    actx.globalAlpha = alpha * (.14 + .5 * tw * p.z);
    actx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
  }
  actx.globalAlpha = 1;
}
const lumCv = document.createElement('canvas'); lumCv.width = 16; lumCv.height = 4;
const lumCtx = lumCv.getContext('2d', { willReadFrequently: true });
let sampledSource = null, lastHeaderSample = -Infinity, headerTimer = 0;
function sampleHeader(rect, now) {
  if (rect.bottom < CH * .4) {
    hdr.classList.add('veil');
    const el = document.elementsFromPoint(CW / 2, 44).find(n => !n.closest('#loader, header'));
    hdr.classList.toggle('on-light', !(el && el.closest('#manifesto, footer, #chiffres')));
    sampledSource = null;
  } else {
    hdr.classList.remove('veil');
    if (!displayedSource || displayedSource === sampledSource || !cache.has(displayed)) return;
    if (now - lastHeaderSample < 180) {
      if (!headerTimer) headerTimer = setTimeout(() => { headerTimer = 0; wakeFilm(); }, 180 - (now - lastHeaderSample));
      return;
    }
    lastHeaderSample = now;
    const src = displayedSource;
    lumCtx.drawImage(src, 0, 0, src.width, src.height * .16, 0, 0, 16, 4);
    const data = lumCtx.getImageData(0, 0, 16, 4).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
    hdr.classList.toggle('on-light', sum / (data.length / 4) > 138);
    sampledSource = src;
  }
}
function beatAlpha(beat, p) {
  if (p < beat.in || p > beat.out) return 0;
  if (p < beat.peak) return (p - beat.in) / Math.max(.0001, beat.peak - beat.in);
  return beat.out > 1.5 ? 1 : 1 - (p - beat.peak) / Math.max(.0001, beat.out - beat.peak);
}
const fadeBottom = $('#fadeBottom'), chapterEl = $('#chapter'), chapterName = $('#chapterName');
const chapterBar = $('#chapterBar'), skipEl = $('#skipFilm'), dimEl = $('#dim');
const grainEl = $('.grain'), vinEl = $('.vignette');
let lastOverlayProgress = -1, lastChapter = -1;
function updateOverlays(p, inFilm) {
  if (p === lastOverlayProgress) return;
  lastOverlayProgress = p;
  let dim = 0;
  for (const beat of beats) {
    const a = beatAlpha(beat, p);
    dim = Math.max(dim, a * beat.dim);
    beat.el.style.opacity = a.toFixed(3);
    beat.el.style.visibility = a <= .001 ? 'hidden' : 'visible';
    if (!beat.hero) beat.el.style.transform = `translateY(${(1 - a) * 26 * (p > beat.peak ? -1 : 1)}px)`;
  }
  dimEl.style.opacity = (dim * .85).toFixed(3);
  const seam = Math.max(0, (p - .92) / .08);
  fadeBottom.style.opacity = seam.toFixed(3);
  if (!mobileFilm) grainEl.style.opacity = (.07 * (1 - seam)).toFixed(3);
  vinEl.style.opacity = (1 - seam).toFixed(3);
  chapterEl.classList.toggle('show', inFilm && p > .04 && p < .985);
  skipEl.classList.toggle('show', inFilm && p > .03 && p < .86);
  const chapter = Math.min(4, Math.floor(p * 5));
  if (chapter !== lastChapter) { chapterName.textContent = chapters[chapter]; lastChapter = chapter; }
  chapterBar.style.transformOrigin = 'left'; chapterBar.style.width = '100%';
  chapterBar.style.transform = `scaleX(${p * 5 - chapter})`;
}
function tick(now) {
  rafId = 0;
  if (document.hidden) return;
  const rect = filmEl.getBoundingClientRect();
  const elapsed = Math.min(64, lastTick ? now - lastTick : 16.67); lastTick = now;
  prog = Math.max(0, Math.min(1, -rect.top / Math.max(1, rect.height - CH)));
  filmVisible = rect.bottom > 0 && rect.top < innerHeight;
  const target = prog * (FRAME_COUNT - 1);
  const alpha = mobileFilm || reduceMotion ? 1 : 1 - Math.pow(.86, elapsed / 16.67);
  currentFrame += (target - currentFrame) * alpha;
  if (Math.abs(target - currentFrame) < .05) currentFrame = target;
  if (filmVisible) {
    ensureFrames(Math.round(currentFrame)); drawFrame(Math.round(currentFrame));
    if (!window.__ready && !bootTimer && !bootDismissed) monitorFilmLoading();
  } else {
    frameQueue = []; bootDismissed = false;
    for (const request of pending.values()) request.cancelled = true;
  }
  sampleHeader(rect, now);
  updateOverlays(prog, rect.top <= 0 && rect.bottom >= CH);
  const ambient = filmVisible ? Math.max(0, 1 - prog / .07) : 0;
  drawAmbient(now, ambient);
  if (filmVisible && (currentFrame !== target || (!mobileFilm && !reduceMotion && ambient > .005))) wakeFilm();
}

function monitorFilmLoading() {
  clearInterval(bootTimer);
  const started = performance.now();
  window.__ready = false;
  bootTimer = setInterval(() => {
    if (!filmVisible) {
      clearInterval(bootTimer); bootTimer = 0;
      $('#loader').classList.add('done');
      return;
    }
    const pack = getPack();
    const ready = !!pack.blob && cache.has(Math.round(currentFrame));
    const error = pack.error || failures.has(Math.round(currentFrame));
    const percent = ready ? 100 : Math.floor(pack.progress * 95);
    $('#loadBar').style.transform = `scaleX(${percent / 100})`;
    $('#loadPct').textContent = error ? 'Не удалось загрузить фильм' : `${percent}%`;
    $('#loadRetry').hidden = !error;
    $('#loadSkip').hidden = !error && performance.now() - started < 7000;
    // Семь секунд ограничивают ожидание шрифтов, но не открывают недогруженный фильм.
    if (!ready || (!fontsDone && performance.now() - started < 7000)) {
      if (filmVisible && (error || performance.now() - started > 250)) $('#loader').classList.remove('done');
      return;
    }
    clearInterval(bootTimer); bootTimer = 0;
    $('#loader').classList.add('done');
    window.__ready = true;
    wakeFilm();
  }, 80);
}

function startFilm() {
  if (mobileFilm) document.documentElement.classList.add('mobile-film');
  sizeCanvases();
  engineStarted = true;
  addEventListener('scroll', wakeFilm, { passive: true });
  addEventListener('resize', () => { if (sizeCanvases()) wakeFilm(); }, { passive: true });
  addEventListener('pageshow', () => { sizeCanvases(); wakeFilm(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId); rafId = 0;
      for (const request of pending.values()) request.cancelled = true;
    } else { lastTick = 0; sizeCanvases(); wakeFilm(); }
  });
  $('#loadRetry').addEventListener('click', () => {
    packs.delete(packProfile());
    resetFrames();
    ensureFrames(Math.round(currentFrame));
    $('#loadRetry').hidden = true;
    monitorFilmLoading();
  });
  $('#loadSkip').addEventListener('click', () => {
    clearInterval(bootTimer); bootTimer = 0; bootDismissed = true;
    $('#loader').classList.add('done');
  });
  if (JUMP !== null) scrollTo(0, +JUMP || 0);
  tick(performance.now());
  monitorFilmLoading();
}
