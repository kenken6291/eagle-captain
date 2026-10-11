/* =========================================================
 * app.js  — 地図制御・フライト演出・行き先選定・Gemini/TTS連携
 * ========================================================= */
(() => {
  "use strict";

  const C = window.Cesium;
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];

  const COLOR_PIN = C.Color.fromCssColorString("#d9442b");
  const COLOR_HI = C.Color.fromCssColorString("#f4c867");
  const COLOR_CUR = C.Color.fromCssColorString("#3fa796");

  /* ---------- 状態 ---------- */
  const S = {
    started: false,
    viewer: null,
    terrainOn: false,
    themes: [],
    themeId: "",
    spots: [],
    spotsCache: {},
    entities: new Map(),
    current: null,      // 現在いるスポット
    busy: false,        // 飛行・演出中
    orbitOff: null,     // 旋回リスナー解除関数
    orbitView: null,
    muted: localStorage.getItem(APP_CONFIG.STORAGE_KEY_MUTE) === "1",
    importDraft: []
  };

  /* =========================================================
   * 効果音（WebAudio・外部ファイル不要）
   * ========================================================= */
  const Sfx = {
    ctx: null, noise: null, windNodes: null,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        const len = this.ctx.sampleRate;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    },
    _noiseHit(t, { hp = 1500, gain = .3, dur = .08 } = {}) {
      const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = this.noise; f.type = "highpass"; f.frequency.value = hp;
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(.001, t + dur);
      src.connect(f).connect(g).connect(ctx.destination);
      src.start(t); src.stop(t + dur + .02);
    },
    tick() {
      if (S.muted || !this.ensure()) return;
      const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square"; o.frequency.value = 1100;
      g.gain.setValueAtTime(.06, t); g.gain.exponentialRampToValueAtTime(.001, t + .05);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + .06);
    },
    drumroll(sec = 3.5) {
      if (S.muted || !this.ensure()) return;
      const t0 = this.ctx.currentTime;
      for (let t = 0; t < sec; t += .045) this._noiseHit(t0 + t, { gain: .05 + .25 * (t / sec), dur: .06 });
    },
    crash() {
      if (S.muted || !this.ensure()) return;
      const ctx = this.ctx, t = ctx.currentTime;
      this._noiseHit(t, { hp: 5000, gain: .5, dur: 1.6 });
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(40, t + .5);
      g.gain.setValueAtTime(.6, t); g.gain.exponentialRampToValueAtTime(.001, t + .6);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + .65);
    },
    chime() {
      if (S.muted || !this.ensure()) return;
      const ctx = this.ctx, t = ctx.currentTime;
      [784, 1047, 1319].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), s = t + i * .12;
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(.0001, s); g.gain.exponentialRampToValueAtTime(.18, s + .02);
        g.gain.exponentialRampToValueAtTime(.001, s + .9);
        o.connect(g).connect(ctx.destination); o.start(s); o.stop(s + 1);
      });
    },
    wind(on) {
      if (!this.ensure()) return;
      const ctx = this.ctx;
      if (on && !this.windNodes && !S.muted) {
        const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        src.buffer = this.noise; src.loop = true;
        f.type = "lowpass"; f.frequency.value = 600;
        lfo.frequency.value = .35; lg.gain.value = 250;
        lfo.connect(lg).connect(f.frequency);
        g.gain.setValueAtTime(.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(.22, ctx.currentTime + .8);
        src.connect(f).connect(g).connect(ctx.destination);
        src.start(); lfo.start();
        this.windNodes = { src, g, lfo };
      } else if (!on && this.windNodes) {
        const { src, g, lfo } = this.windNodes, t = ctx.currentTime;
        g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value || .2, t);
        g.gain.exponentialRampToValueAtTime(.0001, t + 1);
        src.stop(t + 1.05); lfo.stop(t + 1.05);
        this.windNodes = null;
      }
    }
  };

  /* =========================================================
   * 隊長ボイス（Gemini TTS → 失敗時ブラウザ音声）
   * ========================================================= */
  const Voice = {
    chain: Promise.resolve(),
    gen: 0,
    audio: null,
    cache: new Map(),   // text -> Promise<objectURL>

    /** 吹き出し＋音声をキューに積む（順番に再生） */
    say(text) {
      const myGen = this.gen;
      if (APP_CONFIG.VOICE_MODE === "gemini" && !S.muted) this.prefetch(text);
      this.chain = this.chain.then(() => myGen === this.gen ? this._play(text, myGen) : null).catch(() => {});
      return this.chain;
    },

    /** キューを破棄して即停止 */
    reset() {
      this.gen++;
      if (this.audio) { this.audio.pause(); this.audio = null; }
      if (window.speechSynthesis) speechSynthesis.cancel();
      this.chain = Promise.resolve();
      $("#captain").classList.remove("talking");
    },

    prefetch(text) {
      if (APP_CONFIG.VOICE_MODE !== "gemini" || !text) return null;
      if (!this.cache.has(text)) {
        const p = Api.call("tts", { text })
          .then(res => URL.createObjectURL(Voice.toBlob(res.data, res.mimeType)))
          .catch(err => { this.cache.delete(text); throw err; });
        p.catch(() => {});
        this.cache.set(text, p);
      }
      return this.cache.get(text);
    },

    async _play(text, myGen) {
      showBubble(text);
      if (S.muted) { await sleep(clamp(text.length * 90, 1800, 6000)); return; }
      const cap = $("#captain");
      cap.classList.add("talking");
      try {
        if (APP_CONFIG.VOICE_MODE === "gemini") {
          try {
            const url = await this.prefetch(text);
            if (myGen !== this.gen) return;
            await this._playUrl(url);
            return;
          } catch (e) {
            if (e && e.name === "NotAllowedError") return; // 自動再生ブロック時は吹き出しのみ
            debugLog("TTS fallback", e);
          }
        }
        if (myGen !== this.gen) return;
        await this._browserSpeak(text);
      } finally {
        if (myGen === this.gen) cap.classList.remove("talking");
      }
    },

    _playUrl(url) {
      return new Promise((resolve, reject) => {
        const a = new Audio(url);
        this.audio = a;
        a.onended = () => resolve();
        a.onerror = () => reject(new Error("audio error"));
        a.play().catch(reject);
      });
    },

    _browserSpeak(text) {
      return new Promise(resolve => {
        if (!window.speechSynthesis) return resolve();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "ja-JP"; u.pitch = .55; u.rate = 1.05; u.volume = 1;
        const voices = speechSynthesis.getVoices().filter(v => /ja/i.test(v.lang));
        const male = voices.find(v => /otoya|ichiro|keita|男性|male|daichi/i.test(v.name));
        if (male || voices[0]) u.voice = male || voices[0];
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 20000);
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
      });
    },

    /** Gemini TTS の PCM(L16) を WAV に変換 */
    toBlob(b64, mime = "") {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (!/L16|pcm/i.test(mime)) return new Blob([bytes], { type: mime || "audio/wav" });
      const rate = +((/rate=(\d+)/i.exec(mime) || [])[1] || 24000);
      const buf = new ArrayBuffer(44 + bytes.length), v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, "RIFF"); v.setUint32(4, 36 + bytes.length, true); w(8, "WAVE");
      w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, "data"); v.setUint32(40, bytes.length, true);
      new Uint8Array(buf, 44).set(bytes);
      return new Blob([buf], { type: "audio/wav" });
    }
  };

  let bubbleTimer = null;
  function showBubble(text) {
    const b = $("#captainBubble");
    b.classList.remove("hidden");
    $("#captainText").textContent = text;
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => b.classList.add("hidden"), clamp(text.length * 160, 5000, 16000));
  }

  /* =========================================================
   * 起動
   * ========================================================= */
  async function start(user) {
    if (S.started) return;
    S.started = true;
    $("#appTitle").textContent = APP_CONFIG.APP_TITLE.replace(/^あの場所は今_/, "");
    initViewer();
    bindUI();
    updateMuteBtn();
    await loadThemes();
    Voice.say(`よく来たな、${user?.display_name || "搭乗者"}！ワシがイーグル隊長だ！今日はどこへ飛ぶ？`);
  }

  function initViewer() {
    if (APP_CONFIG.CESIUM_ION_TOKEN) C.Ion.defaultAccessToken = APP_CONFIG.CESIUM_ION_TOKEN;
    S.terrainOn = !!APP_CONFIG.CESIUM_ION_TOKEN;

    const imagery = new C.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 19,
      credit: new C.Credit("Imagery © Esri, Maxar, Earthstar Geographics")
    });

    const opts = {
      baseLayer: new C.ImageryLayer(imagery),
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false
    };
    if (S.terrainOn) opts.terrain = C.Terrain.fromWorldTerrain();

    const v = new C.Viewer("cesiumContainer", opts);
    S.viewer = v;
    v.scene.globe.depthTestAgainstTerrain = false;
    v.scene.fog.enabled = true;
    v.scene.skyAtmosphere.show = true;
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(139.7, 35.6, 2.0e7) });

    if (S.terrainOn) {
      C.createOsmBuildingsAsync().then(t => v.scene.primitives.add(t)).catch(() => {});
    }

    // ピンのクリック
    const handler = new C.ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction(click => {
      const picked = v.scene.pick(click.position);
      const sp = picked && picked.id && picked.id.spot;
      if (sp) onPinClick(sp);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    // 操作したら旋回を止める
    handler.setInputAction(() => stopOrbit(), C.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(() => stopOrbit(), C.ScreenSpaceEventType.WHEEL);

    // 計器（HUD）
    let last = 0;
    v.scene.postRender.addEventListener(() => {
      const now = performance.now();
      if (now - last < 150) return;
      last = now;
      const cam = v.camera, h = cam.positionCartographic.height;
      $("#hudAlt").textContent = h > 100000 ? `${Math.round(h / 1000).toLocaleString()} km` : `${Math.round(h).toLocaleString()} m`;
      $("#hudHdg").textContent = `${String(Math.round((toDeg(cam.heading) + 360) % 360)).padStart(3, "0")}°`;
      $("#hudPitch").textContent = `${Math.round(toDeg(cam.pitch))}°`;
    });
  }

  function bindUI() {
    $("#themeSelect").addEventListener("change", e => selectTheme(e.target.value));
    $("#btnRoulette").addEventListener("click", modeRoulette);
    $("#btnWind").addEventListener("click", modeWind);
    $("#btnQuiz").addEventListener("click", modeQuiz);
    $("#btnOverview").addEventListener("click", () => {
      if (guardBusy()) return;
      stopOrbit(); hideCard(); closeVideo(); S.current = null; refreshPinColors();
      $("#hudTarget").textContent = "上空待機中";
      flyOverview();
    });
    $("#btnMute").addEventListener("click", () => {
      S.muted = !S.muted;
      localStorage.setItem(APP_CONFIG.STORAGE_KEY_MUTE, S.muted ? "1" : "0");
      if (S.muted) { Voice.reset(); Sfx.wind(false); }
      updateMuteBtn();
    });
    $("#cardClose").addEventListener("click", hideCard);
    $("#videoClose").addEventListener("click", closeVideo);

    // 取り込みモーダル
    $("#btnImport").addEventListener("click", openImport);
    $("#importClose").addEventListener("click", () => $("#importModal").classList.add("hidden"));
    $("#importTheme").addEventListener("change", e => $("#newThemeFields").classList.toggle("hidden", e.target.value !== "__new__"));
    $("#btnGenerate").addEventListener("click", generateSpots);
    $("#btnSaveSpots").addEventListener("click", saveSpots);

    // Escで閉じる
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (!$("#videoOverlay").classList.contains("hidden")) closeVideo();
      else if (!$("#importModal").classList.contains("hidden")) $("#importModal").classList.add("hidden");
    });

    // 初回操作で AudioContext を有効化
    document.addEventListener("pointerdown", () => Sfx.ensure(), { once: true });
  }

  function updateMuteBtn() {
    const b = $("#btnMute");
    b.textContent = S.muted ? "🔇" : "🔊";
    b.setAttribute("aria-pressed", String(S.muted));
  }

  function guardBusy() {
    if (S.busy) { showToast("飛行中だ！しっかり掴まって待っておれ！"); return true; }
    if (S.spots.length < 2) { showToast("このテーマにはスポットが2つ以上必要です。＋ボタンから取り込めます。"); return true; }
    return false;
  }

  /* =========================================================
   * テーマ・スポット
   * ========================================================= */
  async function loadThemes() {
    showLoading("航路図を読み込み中…");
    try {
      const res = await Api.call("getThemes");
      S.themes = res.themes || [];
    } catch (e) {
      hideLoading();
      showToast(e.message, 5000);
      return;
    }
    hideLoading();
    renderThemeTabs();
    const saved = localStorage.getItem(APP_CONFIG.STORAGE_KEY_THEME);
    const first = S.themes.find(t => t.theme_id === saved) || S.themes[0];
    if (first) await selectTheme(first.theme_id, true);
  }

  function renderThemeTabs() {
    $("#themeTabs").innerHTML = S.themes.map(t =>
      `<button class="theme-tab" data-id="${esc(t.theme_id)}">${esc(t.icon || "📍")} ${esc(t.theme_name)}</button>`).join("");
    $$("#themeTabs .theme-tab").forEach(b => b.addEventListener("click", () => selectTheme(b.dataset.id)));
    $("#themeSelect").innerHTML = S.themes.map(t =>
      `<option value="${esc(t.theme_id)}">${esc(t.icon || "📍")} ${esc(t.theme_name)}</option>`).join("");
  }

  function currentTheme() { return S.themes.find(t => t.theme_id === S.themeId) || {}; }

  async function selectTheme(id, silent = false, force = false) {
    if (S.busy) return showToast("飛行中はテーマを変えられないぞ！");
    S.themeId = id;
    localStorage.setItem(APP_CONFIG.STORAGE_KEY_THEME, id);
    $$("#themeTabs .theme-tab").forEach(b => b.classList.toggle("active", b.dataset.id === id));
    $("#themeSelect").value = id;
    stopOrbit(); hideCard(); closeVideo();
    S.current = null;
    $("#hudTarget").textContent = "上空待機中";

    if (!S.spotsCache[id] || force) {
      showLoading("スポットを読み込み中…");
      try {
        const res = await Api.call("getSpots", { theme_id: id });
        S.spotsCache[id] = res.spots || [];
      } catch (e) {
        showToast(e.message, 5000);
        S.spotsCache[id] = [];
      } finally { hideLoading(); }
    }
    S.spots = S.spotsCache[id];
    renderPins();
    flyOverview();
    if (!silent) {
      Voice.reset();
      Voice.say(`${currentTheme().theme_name}ツアーだな！まずは上空から全体を見渡すぞ！`);
    }
  }

  function renderPins() {
    const v = S.viewer;
    S.entities.forEach(e => v.entities.remove(e));
    S.entities.clear();
    S.spots.forEach(sp => {
      const e = v.entities.add({
        position: C.Cartesian3.fromDegrees(sp.lng, sp.lat, 0),
        point: {
          pixelSize: 14, color: COLOR_PIN, outlineColor: C.Color.WHITE, outlineWidth: 2,
          heightReference: S.terrainOn ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: sp.name,
          font: '700 14px "M PLUS 1p", sans-serif',
          fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true, backgroundColor: C.Color.fromCssColorString("rgba(15,39,64,.75)"),
          pixelOffset: new C.Cartesian2(0, -24),
          heightReference: S.terrainOn ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new C.NearFarScalar(2e5, 1, 2e7, .65)
        }
      });
      e.spot = sp;
      S.entities.set(sp.spot_id, e);
    });
  }

  function setPin(sp, mode) {
    const e = S.entities.get(sp.spot_id);
    if (!e) return;
    const style = {
      normal: [14, COLOR_PIN],
      hi: [28, COLOR_HI],
      current: [20, COLOR_CUR]
    }[mode];
    e.point.pixelSize = style[0];
    e.point.color = style[1];
  }
  function refreshPinColors() {
    S.spots.forEach(sp => setPin(sp, S.current && S.current.spot_id === sp.spot_id ? "current" : "normal"));
  }

  /* =========================================================
   * カメラ制御
   * ========================================================= */
  function flyP(opts) {
    return new Promise(res => S.viewer.camera.flyTo({ ...opts, complete: () => res(true), cancel: () => res(false) }));
  }
  function flySphereP(target, offset, opts) {
    return new Promise(res => S.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(target, 1),
      { offset, ...opts, complete: () => res(true), cancel: () => res(false) }));
  }

  function overviewPosition() {
    const th = currentTheme();
    let lat, lng, zoom;
    const dc = String(th.default_center || "").split(",").map(Number);
    if (dc.length >= 2 && dc.every(n => !isNaN(n))) { [lat, lng, zoom] = dc; }
    if (lat === undefined && S.spots.length) {
      lat = S.spots.reduce((s, p) => s + p.lat, 0) / S.spots.length;
      lng = S.spots.reduce((s, p) => s + p.lng, 0) / S.spots.length;
    }
    if (lat === undefined) { lat = 35.68; lng = 139.76; }
    zoom = zoom || 4;
    const h = clamp(4.0e7 / Math.pow(2, zoom), 8000, 2.2e7);
    return { lat, lng, h };
  }

  function flyOverview(duration = 2.5, higher = false) {
    const { lat, lng, h } = overviewPosition();
    return flyP({
      destination: C.Cartesian3.fromDegrees(lng, lat, higher ? h * 1.4 : h),
      orientation: { heading: 0, pitch: toRad(-90), roll: 0 },
      duration
    });
  }

  async function spotView(sp) {
    let ground = 0;
    if (S.terrainOn) {
      try {
        const [c] = await C.sampleTerrainMostDetailed(S.viewer.terrainProvider, [C.Cartographic.fromDegrees(sp.lng, sp.lat)]);
        ground = c.height || 0;
      } catch (e) { /* 地形取得失敗時は0m */ }
    }
    const pitch = toRad(clamp(+sp.pitch || -25, -89, -5));
    const alt = Math.max(+sp.altitude || 400, 80);
    const range = alt / Math.sin(Math.abs(pitch));
    return {
      target: C.Cartesian3.fromDegrees(sp.lng, sp.lat, ground),
      offset: new C.HeadingPitchRange(toRad(+sp.heading || 0), pitch, range)
    };
  }

  function startOrbit(view) {
    stopOrbit();
    S.orbitView = view;
    let heading = view.offset.heading;
    const cam = S.viewer.camera;
    S.orbitOff = S.viewer.clock.onTick.addEventListener(() => {
      heading += .0022;
      cam.lookAt(view.target, new C.HeadingPitchRange(heading, view.offset.pitch, view.offset.range));
    });
  }
  function stopOrbit() {
    if (S.orbitOff) { S.orbitOff(); S.orbitOff = null; }
    if (S.viewer) S.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
  }

  /* =========================================================
   * フライト本体
   * ========================================================= */
  async function flyToSpot(sp, { dive = false } = {}) {
    if (S.busy) return;
    S.busy = true;
    setModeButtons(false);
    stopOrbit(); closeVideo();

    // 行き先決定：カードをポップアップ＋隊長の号令
    showCard(sp, "depart");
    Voice.say(`目的地は【${sp.name}】だな！しっかり掴まっておれ、出発だ！`);
    const commentP = getComment(sp);
    commentP.then(t => Voice.prefetch(t)).catch(() => {});
    $("#hudTarget").textContent = `→ ${sp.name}`;

    S.spots.forEach(p => setPin(p, p.spot_id === sp.spot_id ? "hi" : "normal"));
    document.body.classList.add("flying");
    Sfx.wind(true);

    const view = await spotView(sp);
    if (dive) {
      // 真上へ移動 → 急降下
      await flyP({
        destination: C.Cartesian3.fromDegrees(sp.lng, sp.lat, 60000),
        orientation: { heading: view.offset.heading, pitch: toRad(-89), roll: 0 },
        duration: 3, easingFunction: C.EasingFunction.QUADRATIC_IN_OUT
      });
      await flySphereP(view.target, view.offset, { duration: 2.2, easingFunction: C.EasingFunction.QUADRATIC_IN });
    } else {
      const camPos = S.viewer.camera.positionWC;
      const dist = C.Cartesian3.distance(camPos, view.target);
      await flySphereP(view.target, view.offset, {
        duration: clamp(3 + dist / 900000, 3.5, 9),
        maximumHeight: clamp(dist * .35, 4000, 2.5e6),
        easingFunction: C.EasingFunction.QUADRATIC_IN_OUT
      });
    }

    document.body.classList.remove("flying");
    Sfx.wind(false);
    Sfx.chime();

    // 到着
    S.current = sp;
    refreshPinColors();
    $("#hudTarget").textContent = sp.name;
    startOrbit(view);

    const comment = await commentP.catch(() => `${sp.name}に到着だ！上空からの眺めは格別だぞ！`);
    Voice.say(comment);
    showCard(sp, "arrived", comment);

    S.busy = false;
    setModeButtons(true);

    if (sp.video_url) setTimeout(() => { if (S.current === sp) openVideo(sp); }, 1500);
  }

  /** 解説セリフ：シートにあればそれを、無ければGeminiで生成 */
  const commentCache = {};
  function getComment(sp) {
    if (sp.eagle_comment) return Promise.resolve(sp.eagle_comment);
    if (!commentCache[sp.spot_id]) {
      commentCache[sp.spot_id] = Api.call("explain", { name: sp.name, tags: sp.tags, theme_name: currentTheme().theme_name })
        .then(r => r.comment)
        .catch(() => `${sp.name}に到着だ！上空からの眺めは格別だぞ！`);
    }
    return commentCache[sp.spot_id];
  }

  function setModeButtons(enabled) {
    ["#btnRoulette", "#btnWind", "#btnQuiz", "#btnOverview"].forEach(s => { $(s).disabled = !enabled; });
  }

  async function onPinClick(sp) {
    if (S.busy) return;
    if (S.current && S.current.spot_id === sp.spot_id) {
      showCard(sp, "arrived", await getComment(sp));
    } else {
      showCard(sp, "preview");
    }
  }

  /* =========================================================
   * 行き先選定 ① 隊長のおまかせダイブ
   * ========================================================= */
  async function modeRoulette() {
    if (guardBusy()) return;
    Sfx.ensure();
    Voice.reset();
    S.busy = true; setModeButtons(false);
    stopOrbit(); hideCard(); closeVideo();

    const shout = "ワシの野生の勘が疼くぞ！……ここだーーっ！";
    Voice.prefetch(shout);
    Voice.say("よーし、ワシに任せろ！上空へ急上昇だ！");
    document.body.classList.add("flying");
    Sfx.wind(true);
    await flyOverview(2.2, true);
    document.body.classList.remove("flying");
    Sfx.wind(false);

    const candidates = S.spots.filter(p => !S.current || p.spot_id !== S.current.spot_id);
    const winner = pickOne(candidates);

    // ドラムロール：ピンを順に光らせ、徐々に減速して当選ピンで止まる
    const steps = 26 + Math.floor(Math.random() * 6);
    const seq = [];
    let pool = [];
    while (seq.length < steps - 1) {
      if (!pool.length) pool = [...S.spots].sort(() => Math.random() - .5);
      const p = pool.pop();
      if (!seq.length || seq[seq.length - 1] !== p) seq.push(p);
    }
    if (seq[seq.length - 1] === winner) seq.pop();
    seq.push(winner);

    Sfx.drumroll(3.8);
    let delay = 55, prev = null;
    for (const p of seq) {
      if (prev) setPin(prev, "normal");
      setPin(p, "hi");
      Sfx.tick();
      prev = p;
      await sleep(delay);
      delay *= 1.085;
    }
    Sfx.crash();
    Voice.say(shout);
    for (let i = 0; i < 3; i++) { setPin(winner, "normal"); await sleep(120); setPin(winner, "hi"); await sleep(120); }

    S.busy = false;
    await flyToSpot(winner, { dive: true });
  }

  /* =========================================================
   * 行き先選定 ② 気流・天候ガチャ
   * ========================================================= */
  const DIRS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  const dirName = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

  function bearing(lat1, lng1, lat2, lng2) {
    const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lng2 - lng1);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  function distanceKm(a, b) {
    const R = 6371, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async function modeWind() {
    if (guardBusy()) return;
    Sfx.ensure();
    Voice.reset();
    S.busy = true; setModeButtons(false);
    stopOrbit(); hideCard(); closeVideo();

    const fromDeg = Math.floor(Math.random() * 8) * 45;
    const toward = (fromDeg + 180) % 360;
    const alt = Math.round(rand(800, 3200) / 100) * 100;
    const speed = Math.round(rand(4, 28));
    const kind = pickOne(["追い風", "上昇気流", "ジェット気流", "海風", "山おろし", "季節風"]);

    // 出発点：現在地 or カメラ直下
    let origin = S.current;
    if (!origin) {
      const c = S.viewer.camera.positionCartographic;
      origin = { lat: toDeg(c.latitude), lng: toDeg(c.longitude) };
    }
    const candidates = S.spots.filter(p => !S.current || p.spot_id !== S.current.spot_id);
    const scored = candidates.map(p => {
      const diff = Math.abs(((bearing(origin.lat, origin.lng, p.lat, p.lng) - toward + 540) % 360) - 180);
      return { p, diff: diff + Math.random() * 8 };
    }).sort((a, b) => a.diff - b.diff);
    const winner = scored[0].p;

    // 演出
    const panel = $("#windGacha"), arrow = $("#windArrow");
    $("#windAlt").textContent = "計測中…"; $("#windDir").textContent = "---"; $("#windSpd").textContent = "--";
    $("#windMsg").textContent = "";
    arrow.style.transition = "none";
    arrow.style.transform = "rotate(0deg)";
    panel.classList.remove("hidden");
    Sfx.wind(true);
    await sleep(60);
    arrow.style.transition = "";
    arrow.style.transform = `rotate(${720 + toward}deg)`; // 矢印＝風が吹いていく方角

    // 数字のスロット演出
    const spin = setInterval(() => {
      $("#windAlt").textContent = `${Math.round(rand(500, 3500))} m`;
      $("#windSpd").textContent = `${Math.round(rand(1, 30))} m/s`;
      $("#windDir").textContent = pickOne(DIRS);
    }, 70);
    await sleep(2200);
    clearInterval(spin);
    $("#windAlt").textContent = `${alt.toLocaleString()} m`;
    $("#windDir").textContent = `${DIRS[fromDeg / 45]}の風`;
    $("#windSpd").textContent = `${speed} m/s`;

    const line1 = `現在の高度${alt.toLocaleString()}メートル、${DIRS[fromDeg / 45]}からの${kind}を検知！風速${speed}メートルだ！`;
    const line2 = `${dirName(toward)}へ流れる気流に乗るぞ！行き先は【${winner.name}】だ！`;
    $("#windMsg").textContent = line1;
    Voice.say(line1);
    await sleep(2600);
    $("#windMsg").textContent = line2;
    await sleep(1800);
    panel.classList.add("hidden");
    Sfx.wind(false);

    S.busy = false;
    await flyToSpot(winner);
  }

  /* =========================================================
   * 行き先選定 ③ 隊長の直感2択クイズ
   * ========================================================= */
  async function modeQuiz() {
    if (guardBusy()) return;
    Sfx.ensure();
    Voice.reset();
    S.busy = true; setModeButtons(false);

    let candidates = S.spots.filter(p => !S.current || p.spot_id !== S.current.spot_id);
    if (candidates.length < 2) candidates = [...S.spots];
    candidates.sort(() => Math.random() - .5);
    const [a, b] = candidates;
    const box = $("#quizContent");
    box.innerHTML = `<div class="quiz-wait"><span style="font-size:28px">🦅</span>隊長が問題を考えておるぞ…</div>`;
    $("#quizModal").classList.remove("hidden");
    Voice.say("ワシからの挑戦状だ！答え次第で行き先が変わるぞ！");

    let q;
    try {
      const res = await Api.call("quiz", {
        theme_name: currentTheme().theme_name,
        current_name: S.current ? S.current.name : "",
        spotA: { name: a.name, tags: a.tags },
        spotB: { name: b.name, tags: b.tags }
      });
      q = res.quiz;
      if (!q || !q.question || !q.optionA || !q.optionB) throw new Error("bad quiz");
    } catch (e) {
      q = fallbackQuiz(a, b);
    }

    box.innerHTML = `
      <p class="quiz-q">${esc(q.question)}</p>
      <div class="quiz-opts">
        <button class="quiz-opt" data-k="A"><b>A</b><span>${esc(q.optionA)}</span></button>
        <button class="quiz-opt" data-k="B"><b>B</b><span>${esc(q.optionB)}</span></button>
      </div>
      <p class="hint" style="margin-top:12px">選んだ答えの方角へ飛ぶぞ。正解かどうかは着いてのお楽しみ…ではなく、すぐ発表だ！</p>
      <div id="quizResult"></div>`;
    Voice.say(q.question);

    $$(".quiz-opt", box).forEach(btn => btn.addEventListener("click", async () => {
      const k = btn.dataset.k;
      const dest = k === "A" ? a : b;
      const correct = String(q.answer).toUpperCase() === k;
      $$(".quiz-opt", box).forEach(x => {
        x.disabled = true;
        x.classList.add(String(q.answer).toUpperCase() === x.dataset.k ? "correct" : "wrong");
      });
      const verdict = correct ? "正解だ！見事な眼力だぞ！" : "残念、ハズレだ！だが旅はこれからだぞ！";
      $("#quizResult").innerHTML = `<div class="quiz-result">
        <strong>${correct ? "⭕ 正解！" : "❌ ハズレ！"}</strong><br>${esc(q.explanation || "")}
        <br><span class="muted">行き先：${esc(dest.name)}</span></div>`;
      Voice.say(`${verdict}${q.explanation || ""}`);
      await sleep(3200);
      $("#quizModal").classList.add("hidden");
      S.busy = false;
      flyToSpot(dest);
    }));
  }

  function fallbackQuiz(a, b) {
    const north = a.lat >= b.lat ? "A" : "B";
    return {
      question: `${a.name}と${b.name}、より北にあるのはどっちだ？`,
      optionA: a.name, optionB: b.name, answer: north,
      explanation: `${north === "A" ? a.name : b.name}の方が北にあるのだ！地図を空から見ればひと目でわかるぞ！`
    };
  }

  /* =========================================================
   * スポットカード
   * ========================================================= */
  function showCard(sp, mode, comment = "") {
    const th = currentTheme();
    $("#cardTheme").textContent = `${th.icon || "📍"} ${th.theme_name || ""}`;
    $("#cardName").textContent = sp.name;
    $("#cardCoords").textContent = `${sp.lat.toFixed(4)}, ${sp.lng.toFixed(4)}　高度 ${Math.round(sp.altitude || 0)} m`;
    $("#cardTags").innerHTML = String(sp.tags || "").split(",").map(t => t.trim()).filter(Boolean)
      .map(t => `<span class="tag">${esc(t)}</span>`).join("");

    const body = $("#cardBody");
    if (mode === "preview") {
      body.innerHTML = `
        <button class="btn-fly" id="btnFlyHere">ここへ飛ぶ！</button>
        <div id="cardWiki"></div>`;
      $("#btnFlyHere").addEventListener("click", () => { Voice.reset(); flyToSpot(sp); });
    } else if (mode === "depart") {
      body.innerHTML = `<p class="muted">🦅 ${esc(sp.name)}へ向けて飛行中…</p><div id="cardWiki"></div>`;
      loadWiki(sp);
    } else {
      const nexts = S.spots.filter(p => p.spot_id !== sp.spot_id)
        .map(p => ({ p, d: distanceKm(sp, p) })).sort((x, y) => x.d - y.d).slice(0, 3);
      const wikiHolder = $("#cardWiki");
      const wikiHtml = wikiHolder && wikiHolder.dataset.spot === sp.spot_id ? wikiHolder.outerHTML : `<div id="cardWiki"></div>`;
      body.innerHTML = `
        ${comment ? `<p class="card-comment">${esc(comment)}</p>` : ""}
        <div class="card-actions">
          <button class="chip-btn" id="btnReplay">🔊 もう一度聞く</button>
          <button class="chip-btn" id="btnOrbit">🔄 旋回</button>
          ${sp.video_url ? `<button class="chip-btn" id="btnVideo">🎬 空撮映像</button>` : ""}
        </div>
        ${wikiHtml}
        <div class="card-section-title">次のフライト候補</div>
        <div class="next-list">
          ${nexts.map(n => `<button class="next-btn" data-id="${esc(n.p.spot_id)}">${esc(n.p.name)}<small>約${Math.round(n.d).toLocaleString()} km</small></button>`).join("")}
        </div>`;
      $("#btnReplay").addEventListener("click", () => { Voice.reset(); Voice.say(comment || sp.eagle_comment || sp.name); });
      $("#btnOrbit").addEventListener("click", () => {
        if (S.orbitOff) stopOrbit();
        else if (S.orbitView && S.current === sp) startOrbit(S.orbitView);
      });
      if (sp.video_url) $("#btnVideo").addEventListener("click", () => openVideo(sp));
      $$(".next-btn", body).forEach(b => b.addEventListener("click", () => {
        const n = S.spots.find(p => p.spot_id === b.dataset.id);
        if (n && !S.busy) { Voice.reset(); flyToSpot(n); }
      }));
      if (!$("#cardWiki").dataset.spot) loadWiki(sp);
    }
    $("#spotCard").classList.remove("hidden");
    document.body.classList.add("card-open");
    if (mode === "preview") loadWiki(sp);
  }

  function hideCard() {
    $("#spotCard").classList.add("hidden");
    document.body.classList.remove("card-open");
  }

  /** Wikipediaから豆知識と写真ギャラリーを取得 */
  const wikiCache = {};
  async function loadWiki(sp) {
    const el = $("#cardWiki");
    if (!el) return;
    el.dataset.spot = sp.spot_id;
    if (!wikiCache[sp.spot_id]) {
      el.innerHTML = `<p class="muted">資料を照会中…</p>`;
      wikiCache[sp.spot_id] = (async () => {
        const r = await fetch(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(sp.name)}`);
        if (!r.ok) throw new Error("no page");
        const s = await r.json();
        if (s.type === "disambiguation") throw new Error("ambiguous");
        let imgs = [];
        try {
          const title = (s.titles && s.titles.canonical) || sp.name;
          const m = await (await fetch(`https://ja.wikipedia.org/api/rest_v1/page/media-list/${encodeURIComponent(title)}`)).json();
          imgs = (m.items || [])
            .filter(i => i.type === "image" && i.srcset && i.srcset.length && !/\.svg/i.test(i.title || ""))
            .slice(0, 6)
            .map(i => { const src = i.srcset[0].src; return src.startsWith("//") ? "https:" + src : src; });
        } catch (e) { /* 画像なしでも続行 */ }
        if (!imgs.length && s.thumbnail) imgs = [s.thumbnail.source];
        return { extract: s.extract || "", url: s.content_urls && s.content_urls.desktop && s.content_urls.desktop.page, imgs };
      })();
    }
    try {
      const w = await wikiCache[sp.spot_id];
      const target = $("#cardWiki");
      if (!target || target.dataset.spot !== sp.spot_id) return;
      const ext = w.extract.length > 180 ? w.extract.slice(0, 180) + "…" : w.extract;
      target.innerHTML = `
        ${ext ? `<div class="card-section-title">豆知識</div><p class="wiki-extract">${esc(ext)}</p>` : ""}
        ${w.imgs.length ? `<div class="gallery">${w.imgs.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(sp.name)}の写真" loading="lazy"></a>`).join("")}</div>` : ""}
        ${w.url ? `<a class="wiki-link" href="${esc(w.url)}" target="_blank" rel="noopener">出典：Wikipedia（CC BY-SA）</a>` : ""}`;
    } catch (e) {
      const target = $("#cardWiki");
      if (target && target.dataset.spot === sp.spot_id) target.innerHTML = "";
    }
  }

  /* =========================================================
   * 空撮映像（Google Earth Studio 等）
   * ========================================================= */
  function videoEmbed(url) {
    const drive = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/);
    if (drive) return `<iframe src="https://drive.google.com/file/d/${drive[1]}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/);
    if (yt) return `<iframe src="https://www.youtube.com/embed/${yt[1]}?autoplay=1&mute=1&loop=1&playlist=${yt[1]}" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
    return `<video src="${esc(url)}" autoplay muted loop playsinline controls></video>`;
  }
  function openVideo(sp) {
    if (!sp.video_url) return;
    $("#videoFrame").innerHTML = videoEmbed(sp.video_url);
    $("#videoOverlay").classList.remove("hidden");
  }
  function closeVideo() {
    $("#videoFrame").innerHTML = "";
    $("#videoOverlay").classList.add("hidden");
  }

  /* =========================================================
   * Geminiによるスポット取り込み
   * ========================================================= */
  function openImport() {
    $("#importTheme").innerHTML =
      S.themes.map(t => `<option value="${esc(t.theme_id)}" ${t.theme_id === S.themeId ? "selected" : ""}>${esc(t.icon || "📍")} ${esc(t.theme_name)}</option>`).join("") +
      `<option value="__new__">＋ 新しいテーマを作る</option>`;
    $("#newThemeFields").classList.add("hidden");
    $("#importPreview").innerHTML = "";
    $("#btnSaveSpots").disabled = true;
    S.importDraft = [];
    $("#importModal").classList.remove("hidden");
  }

  async function generateSpots() {
    const prompt = $("#importPrompt").value.trim();
    const count = clamp(parseInt($("#importCount").value, 10) || 5, 1, 10);
    const sel = $("#importTheme").value;
    if (!prompt) return showToast("取り込みたいスポットの内容を入力してください");
    const themeName = sel === "__new__" ? $("#ntName").value.trim() : (S.themes.find(t => t.theme_id === sel) || {}).theme_name;
    showLoading("隊長が地図を広げて調査中…");
    try {
      const res = await Api.call("generateSpots", { prompt, count, theme_name: themeName || "" });
      S.importDraft = res.spots || [];
      renderImportPreview();
    } catch (e) {
      showToast(e.message, 5000);
    } finally { hideLoading(); }
  }

  function renderImportPreview() {
    const list = S.importDraft;
    if (!list.length) { $("#importPreview").innerHTML = `<p class="muted">スポットが見つかりませんでした。言い回しを変えてお試しください。</p>`; return; }
    $("#importPreview").innerHTML = `
      <table>
        <thead><tr><th>保存</th><th>名前</th><th>緯度, 経度</th><th>高度/方位/傾斜</th><th>タグ</th><th>隊長のセリフ</th></tr></thead>
        <tbody>${list.map((s, i) => `
          <tr>
            <td><input type="checkbox" class="imp-chk" data-i="${i}" checked aria-label="${esc(s.name)}を保存"></td>
            <td><b>${esc(s.name)}</b></td>
            <td class="num"><a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">${(+s.lat).toFixed(4)}, ${(+s.lng).toFixed(4)}</a></td>
            <td class="num">${s.altitude}m / ${s.heading}° / ${s.pitch}°</td>
            <td>${esc(s.tags)}</td>
            <td class="cmt">${esc(s.eagle_comment)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
    $("#btnSaveSpots").disabled = false;
  }

  async function saveSpots() {
    const chosen = $$(".imp-chk").filter(c => c.checked).map(c => S.importDraft[+c.dataset.i]);
    if (!chosen.length) return showToast("保存するスポットにチェックを入れてください");
    let themeId = $("#importTheme").value;
    showLoading("スプレッドシートに保存中…");
    try {
      if (themeId === "__new__") {
        const theme_name = $("#ntName").value.trim();
        const theme_id = $("#ntId").value.trim();
        const icon = $("#ntIcon").value.trim() || "📍";
        if (!theme_name || !/^[a-z0-9_]{2,40}$/.test(theme_id)) {
          hideLoading();
          return showToast("テーマ名と、半角小文字英数・_ のテーマIDを入力してください", 4000);
        }
        const avg = (k) => chosen.reduce((s, p) => s + (+p[k]), 0) / chosen.length;
        const r = await Api.call("saveTheme", { theme: { theme_id, theme_name, icon, default_center: `${avg("lat").toFixed(4)},${avg("lng").toFixed(4)},6` } });
        S.themes.push(r.theme);
        renderThemeTabs();
        themeId = theme_id;
      }
      const res = await Api.call("saveSpots", { theme_id: themeId, spots: chosen });
      hideLoading();
      showToast(`${res.saved}件を保存しました${res.skipped ? `（重複${res.skipped}件はスキップ）` : ""}`, 4000);
      $("#importModal").classList.add("hidden");
      await selectTheme(themeId, false, true);
    } catch (e) {
      hideLoading();
      showToast(e.message, 5000);
    }
  }

  /* ---------- 公開 ---------- */
  window.App = { start };
})();
