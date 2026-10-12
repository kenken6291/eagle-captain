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
    photoreal: false,   // Google フォトリアル3D が有効か
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
    await initViewer();
    bindUI();
    updateMuteBtn();
    await loadThemes();
    Voice.say(`よく来たな、${user?.display_name || "搭乗者"}！ワシがイーグル隊長だ！今日はどこへ飛ぶ？`);
  }

  async function initViewer() {
    if (APP_CONFIG.CESIUM_ION_TOKEN) C.Ion.defaultAccessToken = APP_CONFIG.CESIUM_ION_TOKEN;
    S.terrainOn = !!APP_CONFIG.CESIUM_ION_TOKEN;

    // 予備の地表：Esri 航空写真（Google 3D が使えないとき）
    const baseLayer = C.ImageryLayer.fromProviderAsync(
      C.ArcGisMapServerImageryProvider.fromBasemapType(C.ArcGisBaseMapType.SATELLITE)
    );
    baseLayer.errorEvent.addEventListener(() => {
      S.viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maximumLevel: 19,
        credit: new C.Credit("© OpenStreetMap contributors")
      }));
    });

    const opts = {
      baseLayer,
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false
    };
    if (S.terrainOn) opts.terrain = C.Terrain.fromWorldTerrain();

    const v = new C.Viewer("cesiumContainer", opts);
    S.viewer = v;
    v.scene.globe.depthTestAgainstTerrain = false;
    v.scene.fog.enabled = true;
    v.scene.fog.density = 0.00025;
    v.scene.skyAtmosphere.show = true;
    v.scene.highDynamicRange = false;
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(139.7, 35.6, 2.0e7) });

    // 本命：Google フォトリアル3D（立体の街並み・山並み）
    if (APP_CONFIG.GOOGLE_MAPS_API_KEY) {
      try {
        C.GoogleMaps.defaultApiKey = APP_CONFIG.GOOGLE_MAPS_API_KEY;
        const tileset = await C.createGooglePhotorealistic3DTileset();
        tileset.maximumScreenSpaceError = 16;
        v.scene.primitives.add(tileset);
        v.scene.globe.show = false;   // 地球の平面画像は隠して3Dだけを見せる
        S.photoreal = true;
      } catch (e) {
        console.warn("Google 3D tiles failed", e);
        showToast("Googleの3D地図を読み込めませんでした。APIキーとMap Tiles APIの設定を確認してください。", 6000);
      }
    } else if (S.terrainOn) {
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
    bindImportUI();
    bindManageUI();

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
      `<button class="theme-tab ${t.theme_id === S.themeId ? "active" : ""}" data-id="${esc(t.theme_id)}">${esc(t.icon || "📍")} ${esc(t.theme_name)}</button>`).join("");
    $$("#themeTabs .theme-tab").forEach(b => b.addEventListener("click", () => selectTheme(b.dataset.id)));
    $("#themeSelect").innerHTML = S.themes.map(t =>
      `<option value="${esc(t.theme_id)}">${esc(t.icon || "📍")} ${esc(t.theme_name)}</option>`).join("");
    if (S.themeId) $("#themeSelect").value = S.themeId;
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
          heightReference: (S.terrainOn || S.photoreal) ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: sp.name,
          font: '700 14px "M PLUS 1p", sans-serif',
          fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true, backgroundColor: C.Color.fromCssColorString("rgba(15,39,64,.75)"),
          pixelOffset: new C.Cartesian2(0, -24),
          heightReference: (S.terrainOn || S.photoreal) ? C.HeightReference.CLAMP_TO_GROUND : C.HeightReference.NONE,
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
    // 真上からではなく、空から斜めに見渡す
    return flySphereP(C.Cartesian3.fromDegrees(lng, lat, 0),
      new C.HeadingPitchRange(0, toRad(-55), higher ? h * 1.5 : h * 1.15), { duration });
  }

  async function groundHeight(sp) {
    const carto = C.Cartographic.fromDegrees(sp.lng, sp.lat);
    const timeout = new Promise(r => setTimeout(() => r(null), 2500));
    try {
      let p = null;
      if (S.photoreal) {
        p = S.viewer.scene.sampleHeightMostDetailed([carto]).then(([c]) => (c && isFinite(c.height) ? c.height : null));
      } else if (S.terrainOn) {
        p = C.sampleTerrainMostDetailed(S.viewer.terrainProvider, [carto]).then(([c]) => c.height || 0);
      }
      if (p) { const h = await Promise.race([p, timeout]); return h == null ? 0 : h; }
    } catch (e) { /* 取得失敗時は0m */ }
    return 0;
  }

  async function spotView(sp) {
    const ground = await groundHeight(sp);
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
        destination: C.Cartesian3.fromDegrees(sp.lng, sp.lat, 25000),
        orientation: { heading: view.offset.heading, pitch: toRad(-89), roll: 0 },
        duration: 3, easingFunction: C.EasingFunction.QUADRATIC_IN_OUT
      });
      await flySphereP(view.target, view.offset, { duration: 2.2, easingFunction: C.EasingFunction.QUADRATIC_IN });
    } else {
      const camPos = S.viewer.camera.positionWC;
      const dist = C.Cartesian3.distance(camPos, view.target);
      await flySphereP(view.target, view.offset, {
        duration: clamp(4 + dist / 800000, 4, 12),
        maximumHeight: clamp(dist * .12, 2500, 300000),
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
   * スポット取り込み（キーワード／名前リスト／CSV）
   * ========================================================= */
  const SPOT_FIELDS = ["name", "lat", "lng", "altitude", "heading", "pitch", "video_url", "eagle_comment", "tags"];
  const HEADER_ALIASES = {
    name: ["name", "spot", "スポット", "スポット名", "名前", "名称"],
    lat: ["lat", "latitude", "緯度"],
    lng: ["lng", "lon", "long", "longitude", "経度"],
    altitude: ["altitude", "alt", "高度"],
    heading: ["heading", "方位", "方位角"],
    pitch: ["pitch", "傾斜", "傾斜角", "ピッチ"],
    video_url: ["video_url", "video", "動画", "動画url", "映像", "映像url"],
    eagle_comment: ["eagle_comment", "comment", "セリフ", "隊長のセリフ", "解説", "コメント"],
    tags: ["tags", "tag", "タグ"]
  };

  function bindImportUI() {
    $("#btnImport").addEventListener("click", openImport);
    $("#importClose").addEventListener("click", () => $("#importModal").classList.add("hidden"));
    $("#importTheme").addEventListener("change", e => {
      $("#newThemeFields").classList.toggle("hidden", e.target.value !== "__new__");
      if (S.importDraft.length) renderImportPreview();
    });
    $$(".imp-tab").forEach(t => t.addEventListener("click", () => switchImportMode(t.dataset.mode)));
    $("#btnGenerate").addEventListener("click", generateSpots);
    $("#importList").addEventListener("input", updateListCount);
    $("#btnResolve").addEventListener("click", resolveList);
    $("#btnParseCsv").addEventListener("click", parseCsvInput);
    $("#btnCsvTemplate").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("#csvSample").textContent); showToast("ひな形をコピーしました"); }
      catch (e) { showToast("コピーできませんでした。ひな形を選択してコピーしてください"); }
    });
    $("#csvFile").addEventListener("change", async e => {
      const f = e.target.files[0];
      if (!f) return;
      $("#importCsv").value = await readTextFile(f);
      e.target.value = "";
      parseCsvInput();
    });
    $("#btnSaveSpots").addEventListener("click", saveSpots);
    $("#importPreview").addEventListener("input", onPreviewEdit);
    $("#importPreview").addEventListener("change", onPreviewEdit);
  }

  function openImport() {
    const sel = $("#importTheme").value || S.themeId;
    $("#importTheme").innerHTML =
      S.themes.map(t => `<option value="${esc(t.theme_id)}" ${t.theme_id === sel ? "selected" : ""}>${esc(t.icon || "📍")} ${esc(t.theme_name)}</option>`).join("") +
      `<option value="__new__">＋ 新しいテーマを作る</option>`;
    $("#newThemeFields").classList.toggle("hidden", $("#importTheme").value !== "__new__");
    $("#importModal").classList.remove("hidden");
    renderImportPreview();
  }

  function switchImportMode(mode) {
    $$(".imp-tab").forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
    $$(".imp-panel").forEach(p => p.classList.toggle("hidden", p.dataset.mode !== mode));
  }

  /** 文字コード自動判定（UTF-8 → だめなら Shift_JIS：Excel保存のCSV対策） */
  async function readTextFile(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder("shift_jis").decode(buf); }
  }

  const toHalf = v => String(v ?? "").replace(/[０-９．－，]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).trim();

  /* ---------- ① キーワード ---------- */
  async function generateSpots() {
    const prompt = $("#importPrompt").value.trim();
    const count = clamp(parseInt($("#importCount").value, 10) || 5, 1, 10);
    if (!prompt) return showToast("探したいスポットの内容を入力してください");
    showLoading("隊長が地図を広げて調査中…");
    try {
      const res = await Api.call("generateSpots", { prompt, count, theme_name: importThemeName() });
      setDraft(res.spots || []);
    } catch (e) {
      showToast(e.message, 5000);
    } finally { hideLoading(); }
  }

  /* ---------- ② 名前リスト ---------- */
  function cleanListLines(text) {
    const seen = new Set();
    return String(text || "").split(/\r?\n/)
      .map(l => l.replace(/^\s*(?:[0-9０-９]+\s*[.)．、:：）]|[（(][0-9０-９]+[)）]|[・\-*•●○◆◇★☆■□▶►※〇]|[①-⑳])\s*/, "").trim())
      .filter(l => l && !seen.has(l) && seen.add(l))
      .slice(0, 30);
  }
  function updateListCount() {
    const n = cleanListLines($("#importList").value).length;
    $("#listCount").textContent = n ? `${n}件` : "";
  }
  async function resolveList() {
    const names = cleanListLines($("#importList").value);
    if (!names.length) return showToast("スポット名を1行に1つずつ入力してください");
    showLoading(`${names.length}件の位置を調べています…`);
    try {
      const res = await Api.call("generateSpots", { names, theme_name: importThemeName() });
      const got = res.spots || [];
      setDraft(got);
      if (got.length < names.length) showToast(`${names.length - got.length}件は場所を特定できませんでした`, 4500);
    } catch (e) {
      showToast(e.message, 5000);
    } finally { hideLoading(); }
  }

  /* ---------- ③ CSV・表 ---------- */
  function parseDelimited(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    const firstLine = text.split(/\r?\n/)[0] || "";
    const delim = firstLine.includes("\t") ? "\t" : ",";
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"' && field === "") q = true;
      else if (ch === delim) { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch !== "\r") field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ""));
  }

  function headerKey(h) {
    const k = String(h || "").toLowerCase().replace(/[\s　]/g, "");
    return Object.keys(HEADER_ALIASES).find(f => HEADER_ALIASES[f].includes(k)) || null;
  }

  async function parseCsvInput() {
    const rows = parseDelimited($("#importCsv").value);
    if (!rows.length) return showToast("CSVの内容を貼り付けてください");

    let keys = rows[0].map(headerKey);
    let body = rows.slice(1);
    if (!keys.includes("name") && !keys.includes("lat")) { keys = SPOT_FIELDS.slice(); body = rows; } // 見出しなし
    const lastIdx = keys.length - 1;

    const list = body.map(r => {
      // 列が多い場合（タグのカンマ等）は最後の列にまとめる
      if (r.length > keys.length) r = r.slice(0, lastIdx).concat(r.slice(lastIdx).join(","));
      const o = {};
      keys.forEach((k, i) => { if (k) o[k] = (r[i] ?? "").trim(); });
      ["lat", "lng", "altitude", "heading", "pitch"].forEach(k => { if (o[k] !== undefined && o[k] !== "") o[k] = Number(toHalf(o[k])); });
      return o;
    }).filter(o => o.name || o.lat);

    if (!list.length) return showToast("読み込めるスポットがありませんでした。見出し（name, lat, lng）を確認してください", 5000);

    // セリフが空欄ならAIで作る
    const missing = list.filter(o => o.name && !o.eagle_comment);
    if ($("#csvAiComment").checked && missing.length) {
      let done = 0;
      showLoading(`隊長のセリフを作成中… 0/${missing.length}`);
      const theme_name = importThemeName();
      const queue = missing.slice(0, 30);
      const worker = async () => {
        while (queue.length) {
          const o = queue.shift();
          try {
            const r = await Api.call("explain", { name: o.name, tags: o.tags || "", theme_name });
            o.eagle_comment = r.comment;
          } catch (e) { /* 空欄のまま（到着時に自動生成） */ }
          $("#loadingText").textContent = `隊長のセリフを作成中… ${++done}/${missing.length}`;
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      hideLoading();
    }
    setDraft(list);
  }

  /* ---------- プレビュー（編集可能な表） ---------- */
  function importThemeName() {
    const sel = $("#importTheme").value;
    return sel === "__new__" ? $("#ntName").value.trim() : ((S.themes.find(t => t.theme_id === sel) || {}).theme_name || "");
  }

  function validateDraft(s) {
    if (!String(s.name || "").trim()) return "名前がありません";
    if (s.lat === "" || s.lat == null || !isFinite(s.lat) || Math.abs(s.lat) > 90) return "緯度が正しくありません";
    if (s.lng === "" || s.lng == null || !isFinite(s.lng) || Math.abs(s.lng) > 180) return "経度が正しくありません";
    return "";
  }

  function existingNames() {
    const sel = $("#importTheme").value;
    return new Set((S.spotsCache[sel] || []).map(p => p.name));
  }

  function setDraft(list) {
    const exist = existingNames();
    S.importDraft = list.map(s => {
      const d = {
        name: String(s.name || "").trim(),
        lat: s.lat === "" || s.lat == null ? "" : Number(s.lat),
        lng: s.lng === "" || s.lng == null ? "" : Number(s.lng),
        altitude: s.altitude ?? "", heading: s.heading ?? "", pitch: s.pitch ?? "",
        video_url: s.video_url || "", eagle_comment: s.eagle_comment || "", tags: s.tags || ""
      };
      d._err = validateDraft(d);
      d._dup = exist.has(d.name);
      d._chk = !d._err && !d._dup;
      return d;
    });
    renderImportPreview();
  }

  function renderImportPreview() {
    const list = S.importDraft;
    $("#importNote").classList.toggle("hidden", !list.length);
    if (!list.length) {
      $("#importPreview").innerHTML = "";
      updateSaveCount();
      return;
    }
    const exist = existingNames();
    list.forEach(d => { d._dup = exist.has(d.name); });
    $("#importPreview").innerHTML = `
      <table>
        <thead><tr><th>保存</th><th>名前</th><th>緯度</th><th>経度</th><th>位置</th><th>隊長のセリフ</th><th>タグ</th></tr></thead>
        <tbody>${list.map((d, i) => `
          <tr data-i="${i}" class="${d._err ? "invalid" : ""}">
            <td><input type="checkbox" class="imp-chk" data-i="${i}" ${d._chk ? "checked" : ""} aria-label="${esc(d.name)}を保存"></td>
            <td><input type="text" data-i="${i}" data-k="name" value="${esc(d.name)}"></td>
            <td><input type="number" step="any" class="num-in" data-i="${i}" data-k="lat" value="${esc(d.lat)}"></td>
            <td><input type="number" step="any" class="num-in" data-i="${i}" data-k="lng" value="${esc(d.lng)}"></td>
            <td>
              <a class="map-link" data-i="${i}" href="${mapLink(d)}" target="_blank" rel="noopener">地図で確認</a>
              <div class="row-err" data-i="${i}">${esc(d._err || (d._dup ? "登録済み" : ""))}</div>
            </td>
            <td><textarea rows="2" data-i="${i}" data-k="eagle_comment" placeholder="空欄なら到着時にAIが作成">${esc(d.eagle_comment)}</textarea></td>
            <td><input type="text" data-i="${i}" data-k="tags" value="${esc(d.tags)}"></td>
          </tr>`).join("")}
        </tbody>
      </table>`;
    updateSaveCount();
  }

  function mapLink(d) {
    return isFinite(d.lat) && isFinite(d.lng) && d.lat !== "" && d.lng !== ""
      ? `https://www.google.com/maps?q=${d.lat},${d.lng}` : `https://www.google.com/maps/search/${encodeURIComponent(d.name)}`;
  }

  function onPreviewEdit(e) {
    const el = e.target, i = +el.dataset.i;
    const d = S.importDraft[i];
    if (!d) return;
    if (el.classList.contains("imp-chk")) {
      d._chk = el.checked;
    } else if (el.dataset.k) {
      const k = el.dataset.k;
      d[k] = (k === "lat" || k === "lng") ? (el.value === "" ? "" : Number(toHalf(el.value))) : el.value;
      d._err = validateDraft(d);
      const tr = el.closest("tr");
      tr.classList.toggle("invalid", !!d._err);
      $(`.map-link[data-i="${i}"]`).href = mapLink(d);
      $(`.row-err[data-i="${i}"]`).textContent = d._err || (existingNames().has(d.name) ? "登録済み" : "");
    }
    updateSaveCount();
  }

  function updateSaveCount() {
    const n = S.importDraft.filter(d => d._chk).length;
    $("#saveCount").textContent = S.importDraft.length ? `${S.importDraft.length}件中 ${n}件を保存` : "";
    $("#btnSaveSpots").disabled = n === 0;
  }

  async function saveSpots() {
    const chosen = S.importDraft.filter(d => d._chk);
    if (!chosen.length) return showToast("保存するスポットにチェックを入れてください");
    const bad = chosen.find(d => d._err);
    if (bad) return showToast(`「${bad.name || "名前なし"}」：${bad._err}`, 4500);
    const payload = chosen.map(d => {
      const o = {};
      SPOT_FIELDS.forEach(k => { o[k] = d[k]; });
      return o;
    });

    let themeId = $("#importTheme").value;
    showLoading("スプレッドシートに保存中…");
    try {
      if (themeId === "__new__") {
        const theme_name = $("#ntName").value.trim();
        const theme_id = $("#ntId").value.trim();
        const icon = $("#ntIcon").value.trim() || "📍";
        if (!theme_name || (theme_id && !/^[a-z0-9_]{2,40}$/.test(theme_id))) {
          hideLoading();
          return showToast("テーマ名を入力してください（テーマIDは空欄か、半角小文字英数と_）", 4000);
        }
        const avg = k => payload.reduce((sum, p) => sum + (+p[k]), 0) / payload.length;
        const r = await Api.call("saveTheme", { theme: { theme_id, theme_name, icon, default_center: `${avg("lat").toFixed(4)},${avg("lng").toFixed(4)},6` } });
        S.themes.push(r.theme);
        renderThemeTabs();
        themeId = r.theme.theme_id;
      }
      const res = await Api.call("saveSpots", { theme_id: themeId, spots: payload });
      hideLoading();
      showToast(`${res.saved}件を保存しました${res.skipped ? `（登録済み${res.skipped}件はスキップ）` : ""}`, 4000);
      S.importDraft = [];
      renderImportPreview();
      $("#importModal").classList.add("hidden");
      await selectTheme(themeId, false, true);
    } catch (e) {
      hideLoading();
      showToast(e.message, 5000);
    }
  }

  /* =========================================================
   * カテゴリ・スポット管理（追加・名前変更・一括削除）
   * ========================================================= */
  const M = { themeId: "", batch: "all", spots: [], sel: new Set(), isAdmin: false };

  function bindManageUI() {
    $("#btnManage").addEventListener("click", openManage);
    $("#btnManageMenu").addEventListener("click", openManage);
    $("#manageClose").addEventListener("click", () => $("#manageModal").classList.add("hidden"));
    $("#mgTheme").addEventListener("change", e => loadManageSpots(e.target.value));
    $("#mgBatch").addEventListener("change", e => { M.batch = e.target.value; M.sel.clear(); renderManageSpots(); });
    $("#mgAll").addEventListener("change", e => {
      visibleManageSpots().filter(x => x.can_delete).forEach(x => (e.target.checked ? M.sel.add(x.spot_id) : M.sel.delete(x.spot_id)));
      renderManageSpots();
    });
    $("#mgSpotList").addEventListener("change", e => {
      const id = e.target.dataset.id;
      if (!id) return;
      if (e.target.checked) M.sel.add(id); else M.sel.delete(id);
      updateManageCount();
    });
    $("#btnDeleteSpots").addEventListener("click", deleteSelectedSpots);
    $("#btnAddTheme").addEventListener("click", addTheme);
    $("#newThemeName").addEventListener("keydown", e => { if (e.key === "Enter") addTheme(); });
    $("#mgThemeList").addEventListener("click", onManageThemeClick);
  }

  function openManage() {
    const admin = !!(Auth.user && Auth.user.is_admin);
    $("#mgRole").textContent = admin
      ? "管理者としてログイン中：すべてのカテゴリとスポットを変更・削除できます。"
      : "自分で作成したカテゴリと、自分が取り込んだスポットを変更・削除できます（🔒は変更できません）。";
    renderManageThemes();
    $("#manageModal").classList.remove("hidden");
    loadManageSpots(M.themeId && S.themes.some(t => t.theme_id === M.themeId) ? M.themeId : S.themeId);
  }

  function renderManageThemes() {
    $("#mgThemeList").innerHTML = S.themes.map(t => `
      <div class="mg-theme-row" data-id="${esc(t.theme_id)}">
        <input type="text" class="mg-icon" maxlength="4" value="${esc(t.icon || "📍")}" aria-label="アイコン" ${t.can_edit ? "" : "disabled"}>
        <input type="text" class="mg-tname" maxlength="30" value="${esc(t.theme_name)}" aria-label="カテゴリ名" ${t.can_edit ? "" : "disabled"}>
        ${t.can_edit
          ? `<button class="chip-btn" data-act="rename">名前を保存</button>
             <button class="chip-btn danger" data-act="delete">削除</button>`
          : `<span class="mg-lock" style="grid-column: span 2">🔒 変更できません</span>`}
      </div>`).join("");
    $("#mgTheme").innerHTML = S.themes.map(t =>
      `<option value="${esc(t.theme_id)}">${esc(t.icon || "📍")} ${esc(t.theme_name)}</option>`).join("");
    if (M.themeId) $("#mgTheme").value = M.themeId;
  }

  async function addTheme() {
    const theme_name = $("#newThemeName").value.trim();
    const icon = $("#newThemeIcon").value.trim() || "📍";
    if (!theme_name) return showToast("新しいカテゴリ名を入力してください");
    showLoading("カテゴリを追加中…");
    try {
      const r = await Api.call("saveTheme", { theme: { theme_name, icon } });
      S.themes.push(r.theme);
      S.spotsCache[r.theme.theme_id] = [];
      $("#newThemeName").value = ""; $("#newThemeIcon").value = "";
      renderThemeTabs();
      renderManageThemes();
      showToast(`カテゴリ「${theme_name}」を追加しました。＋スポット取込から中身を入れられます`, 4500);
    } catch (e) {
      showToast(e.message, 5000);
    } finally { hideLoading(); }
  }

  async function onManageThemeClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const row = btn.closest(".mg-theme-row");
    const id = row.dataset.id;
    const theme = S.themes.find(t => t.theme_id === id);
    if (!theme) return;

    if (btn.dataset.act === "rename") {
      const theme_name = $(".mg-tname", row).value.trim();
      const icon = $(".mg-icon", row).value.trim() || "📍";
      if (!theme_name) return showToast("カテゴリ名を入力してください");
      showLoading("名前を変更中…");
      try {
        await Api.call("updateTheme", { theme_id: id, theme_name, icon });
        theme.theme_name = theme_name; theme.icon = icon;
        renderThemeTabs();
        renderManageThemes();
        showToast("カテゴリ名を変更しました");
      } catch (err) {
        showToast(err.message, 5000);
      } finally { hideLoading(); }
    }

    if (btn.dataset.act === "delete") {
      if (S.themes.length <= 1) return showToast("カテゴリが1つしかないため削除できません");
      const n = (S.spotsCache[id] || []).length;
      const ok = confirm(`カテゴリ「${theme.theme_name}」と、その中のスポット${n ? n + "件" : ""}をすべて削除します。\n元に戻せません。よろしいですか？`);
      if (!ok) return;
      showLoading("カテゴリを削除中…");
      try {
        const r = await Api.call("deleteTheme", { theme_id: id });
        S.themes = S.themes.filter(t => t.theme_id !== id);
        delete S.spotsCache[id];
        if (M.themeId === id) M.themeId = "";
        hideLoading();
        showToast(`カテゴリを削除しました（スポット${r.deleted_spots}件）`, 4000);
        if (S.themeId === id) await selectTheme(S.themes[0].theme_id, true);
        renderThemeTabs();
        renderManageThemes();
        loadManageSpots(M.themeId || S.themeId);
      } catch (err) {
        hideLoading();
        showToast(err.message, 5000);
      }
    }
  }

  function batchLabel(b) {
    if (!b) return "初期データ・手入力";
    const m = String(b).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    return m ? `取り込み ${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : String(b);
  }

  async function loadManageSpots(themeId) {
    M.themeId = themeId;
    M.sel.clear();
    M.batch = "all";
    $("#mgTheme").value = themeId;
    $("#mgSpotList").innerHTML = `<div class="mg-empty">読み込み中…</div>`;
    try {
      const r = await Api.call("getManageData", { theme_id: themeId });
      if (M.themeId !== themeId) return;
      M.spots = r.spots || [];
      M.isAdmin = r.is_admin;
    } catch (e) {
      M.spots = [];
      showToast(e.message, 5000);
    }
    // 取り込み単位（新しい順）
    const groups = {};
    M.spots.forEach(x => { groups[x.batch] = (groups[x.batch] || 0) + 1; });
    const keys = Object.keys(groups).sort((a, b) => (b || "0").localeCompare(a || "0"));
    $("#mgBatch").innerHTML = `<option value="all">すべて（${M.spots.length}件）</option>` +
      keys.map(k => `<option value="${esc(k || "__none__")}">${esc(batchLabel(k))}（${groups[k]}件）</option>`).join("");
    renderManageSpots();
  }

  function visibleManageSpots() {
    if (M.batch === "all") return M.spots;
    const b = M.batch === "__none__" ? "" : M.batch;
    return M.spots.filter(x => x.batch === b);
  }

  function renderManageSpots() {
    const list = visibleManageSpots();
    if (!list.length) {
      $("#mgSpotList").innerHTML = `<div class="mg-empty">このカテゴリにはスポットがありません</div>`;
    } else {
      $("#mgSpotList").innerHTML = list.map(x => `
        <label class="mg-spot ${x.can_delete ? "" : "locked"}">
          <input type="checkbox" data-id="${esc(x.spot_id)}" ${M.sel.has(x.spot_id) ? "checked" : ""} ${x.can_delete ? "" : "disabled"}>
          <span class="mg-name">${x.can_delete ? "" : "🔒 "}${esc(x.name)}</span>
          <small>${esc(batchLabel(x.batch))}${x.mine ? "・自分" : ""}</small>
        </label>`).join("");
    }
    const deletable = list.filter(x => x.can_delete);
    $("#mgAll").checked = deletable.length > 0 && deletable.every(x => M.sel.has(x.spot_id));
    $("#mgAll").disabled = deletable.length === 0;
    updateManageCount();
  }

  function updateManageCount() {
    const n = M.sel.size;
    $("#mgCount").textContent = n ? `${n}件を選択中` : "";
    $("#btnDeleteSpots").disabled = n === 0;
    const deletable = visibleManageSpots().filter(x => x.can_delete);
    $("#mgAll").checked = deletable.length > 0 && deletable.every(x => M.sel.has(x.spot_id));
  }

  async function deleteSelectedSpots() {
    const ids = [...M.sel];
    if (!ids.length) return;
    const theme = S.themes.find(t => t.theme_id === M.themeId) || {};
    if (!confirm(`「${theme.theme_name || ""}」から${ids.length}件のスポットを削除します。\n元に戻せません。よろしいですか？`)) return;
    showLoading(`${ids.length}件を削除中…`);
    try {
      const r = await Api.call("deleteSpots", { spot_ids: ids });
      hideLoading();
      showToast(`${r.deleted}件を削除しました${r.denied ? `（権限のない${r.denied}件は残しました）` : ""}`, 4000);
      delete S.spotsCache[M.themeId];
      if (M.themeId === S.themeId) await selectTheme(S.themeId, true, true);
      loadManageSpots(M.themeId);
    } catch (e) {
      hideLoading();
      showToast(e.message, 5000);
    }
  }

  /* ---------- 公開 ---------- */
  window.App = { start };
})();
