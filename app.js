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

  /* カテゴリアイコン：絵文字 または "img:ドライブのファイルID" */
  const isImgIcon = icon => /^img:[\w-]{10,}$/.test(String(icon || ""));
  function iconHtml(icon) {
    if (isImgIcon(icon)) {
      const id = String(icon).slice(4);
      return `<img class="t-ico" src="https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w128" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='https://lh3.googleusercontent.com/d/${esc(id)}=w128'">`;
    }
    return `<span class="t-ico-emoji">${esc(icon || "📍")}</span>`;
  }
  const iconText = icon => (isImgIcon(icon) ? "" : (icon || "📍") + " ");

  const COLOR_PIN = C.Color.fromCssColorString("#d9442b");
  const COLOR_HI = C.Color.fromCssColorString("#f4c867");
  const COLOR_CUR = C.Color.fromCssColorString("#3fa796");
  const COLOR_VISITED = C.Color.fromCssColorString("#3b7d3a");

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
    ds: null,           // スポット用データソース（クラスタリング）
    current: null,      // 現在いるスポット
    busy: false,        // 飛行・演出中
    orbitOff: null,     // 旋回リスナー解除関数
    orbitView: null,
    muted: localStorage.getItem(APP_CONFIG.STORAGE_KEY_MUTE) === "1",
    pinFocus: localStorage.getItem(APP_CONFIG.STORAGE_KEY_PINS) !== "all", // true: 目的地のみ表示
    flyingTo: null,     // 飛行中の目的地
    importDraft: [],
    visits: new Map(),  // spot_id -> 行ったところの記録
    themeTotals: {},
    cardSpot: null
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
    $("#appTitle").textContent = APP_CONFIG.APP_TITLE;
    await loadClientConfig();
    await initViewer();
    bindUI();
    updateMuteBtn();
    await loadVisits();
    await loadThemes();
    Voice.say(`よく来たな、${user?.display_name || "搭乗者"}！鷲の目紀行の案内役、イーグル隊長だ！今日はどこへ飛ぶ？`);
  }

  /** GASのスクリプトプロパティから地図用APIキーなどを受け取る */
  async function loadClientConfig() {
    try {
      const r = await Api.call("getClientConfig");
      if (r.google_maps_api_key) APP_CONFIG.GOOGLE_MAPS_API_KEY = r.google_maps_api_key;
    } catch (e) {
      debugLog("client config failed", e);
    }
  }

  async function initViewer() {
    if (APP_CONFIG.CESIUM_ION_TOKEN) C.Ion.defaultAccessToken = APP_CONFIG.CESIUM_ION_TOKEN;
    S.terrainOn = !!APP_CONFIG.CESIUM_ION_TOKEN;

    // 予備の地表：Esri 航空写真（Google 3D が使えないとき）
    const baseLayer = C.ImageryLayer.fromProviderAsync(
      C.ArcGisMapServerImageryProvider.fromBasemapType(C.ArcGisBaseMapType.SATELLITE, { maximumLevel: 18 }) // 高すぎるズームの404を防ぐ
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

    // 省電力：画面に変化があるときだけ描画する
    opts.requestRenderMode = true;
    opts.maximumRenderTimeChange = Infinity;
    const v = new C.Viewer("cesiumContainer", opts);
    if (IS_MOBILE) v.resolutionScale = Math.min(1, 1.5 / (window.devicePixelRatio || 1)); // スマホは描画解像度を控えめに
    v.clock.onTick.addEventListener(() => { if (S.orbitOff) v.scene.requestRender(); });

    // スポットはクラスタリング（重なったピンと名前を「数字の丸」にまとめる）
    S.ds = new C.CustomDataSource("spots");
    v.dataSources.add(S.ds);
    const cl = S.ds.clustering;
    cl.enabled = true;
    cl.pixelRange = IS_MOBILE ? 46 : 36;
    cl.minimumClusterSize = 2;
    cl.clusterPoints = true;
    cl.clusterLabels = true;
    cl.clusterBillboards = true;
    cl.clusterEvent.addEventListener((ids, cluster) => {
      cluster.label.show = false;
      cluster.point.show = false;
      cluster.billboard.show = true;
      cluster.billboard.image = clusterIcon(ids.length);
      cluster.billboard.verticalOrigin = C.VerticalOrigin.CENTER;
      cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    });
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
        tileset.maximumScreenSpaceError = IS_MOBILE ? 28 : 16;  // スマホは少し粗くして軽く
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
      if (picked && Array.isArray(picked.id)) return zoomToCluster(picked.id);
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
      stopOrbit(); hideCard(); closeVideo(); S.current = null; refreshPinColors(); applyPinVisibility();
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
    // スポット検索
    $("#btnSearch").addEventListener("click", e => {
      e.stopPropagation();
      const p = $("#searchPanel");
      p.classList.toggle("hidden");
      if (!p.classList.contains("hidden")) { $("#searchInput").focus(); runSearch(); }
    });
    let searchTimer = null;
    $("#searchInput").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
    $("#searchInput").addEventListener("keydown", e => {
      if (e.key === "Escape") $("#searchPanel").classList.add("hidden");
      if (e.key === "Enter") { const first = $("#searchResults .sr-item"); if (first) first.click(); }
    });
    $("#searchResults").addEventListener("click", e => {
      const b = e.target.closest(".sr-item");
      if (!b) return;
      const sp = S.spots.find(p => p.spot_id === b.dataset.id);
      if (!sp) return;
      $("#searchPanel").classList.add("hidden");
      if (S.busy) return showToast("飛行中だ！少し待て！");
      Voice.reset();
      flyToSpot(sp);
    });
    $("#searchPanel").addEventListener("click", e => e.stopPropagation());
    document.addEventListener("click", () => $("#searchPanel").classList.add("hidden"));
    updatePinsBtn();
    $("#btnPins").addEventListener("click", () => {
      S.pinFocus = !S.pinFocus;
      localStorage.setItem(APP_CONFIG.STORAGE_KEY_PINS, S.pinFocus ? "focus" : "all");
      updatePinsBtn();
      applyPinVisibility();
      showToast(S.pinFocus ? "到着したスポット以外のピンを隠します" : "すべてのピンを表示します");
    });
    $("#videoClose").addEventListener("click", closeVideo);

    // 取り込みモーダル
    bindImportUI();
    bindManageUI();
    bindVisitUI();
    $("#svBack").addEventListener("click", takeOff);
    $("#svFace").addEventListener("click", faceTarget);
    $("#svMaps").addEventListener("click", () => window.open(mapsPanoUrl(), "_blank", "noopener"));

    // Escで閉じる
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (!$("#videoOverlay").classList.contains("hidden")) closeVideo();
      else if (!$("#importModal").classList.contains("hidden")) $("#importModal").classList.add("hidden");
    });

    // 初回操作で AudioContext を有効化
    document.addEventListener("pointerdown", () => Sfx.ensure(), { once: true });
  }

  /** 表示中のテーマ内を名前・タグで検索 */
  function runSearch() {
    const q = $("#searchInput").value.trim().toLowerCase();
    const box = $("#searchResults");
    const total = S.spots.length;
    if (!q) {
      box.innerHTML = `<p class="sr-note">${esc(currentTheme().theme_name || "")}：${total.toLocaleString()}か所。名前やタグを入力してください。</p>`;
      return;
    }
    const words = q.split(/\s+/);
    const hits = S.spots.filter(sp => {
      const t = `${sp.name} ${sp.tags || ""}`.toLowerCase();
      return words.every(w => t.includes(w));
    });
    hits.sort((x, y) => (x.name.toLowerCase().startsWith(q) ? 0 : 1) - (y.name.toLowerCase().startsWith(q) ? 0 : 1));
    box.innerHTML = `<p class="sr-note">${total.toLocaleString()}か所中 ${hits.length.toLocaleString()}件${hits.length > 40 ? "（上位40件を表示）" : ""}</p>` +
      hits.slice(0, 40).map(sp => `<button class="sr-item" data-id="${esc(sp.spot_id)}">
        <span>${S.visits.has(sp.spot_id) ? "✔ " : ""}${esc(sp.name)}</span><small>${esc(sp.tags || "")}</small></button>`).join("");
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
      `<button class="theme-tab ${t.theme_id === S.themeId ? "active" : ""}" data-id="${esc(t.theme_id)}">${iconHtml(t.icon)} ${esc(t.theme_name)}</button>`).join("");
    $$("#themeTabs .theme-tab").forEach(b => b.addEventListener("click", () => selectTheme(b.dataset.id)));
    $("#themeSelect").innerHTML = S.themes.map(t =>
      `<option value="${esc(t.theme_id)}">${esc(iconText(t.icon))}${esc(t.theme_name)}</option>`).join("");
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

  const IS_MOBILE = window.matchMedia("(max-width: 700px)").matches;
  // 名前は、ある程度近づいたときだけ表示（遠くでは点だけ＝文字だらけを防ぐ）
  const LABEL_NEAR = new C.DistanceDisplayCondition(0, IS_MOBILE ? 150000 : 400000);
  const clusterIconCache = new Map();

  /** クラスタ（まとめた丸）の画像 */
  function clusterIcon(n) {
    const key = n < 10 ? n : n < 50 ? "10+" : n < 100 ? "50+" : n < 500 ? "100+" : "500+";
    const text = n < 10 ? String(n) : n < 1000 ? String(n) : "999+";
    const k = key + ":" + text;
    if (clusterIconCache.has(k)) return clusterIconCache.get(k);
    const size = n < 10 ? 34 : n < 100 ? 40 : n < 500 ? 46 : 52;
    const cv = document.createElement("canvas");
    const r = window.devicePixelRatio > 1 ? 2 : 1;
    cv.width = cv.height = size * r;
    const ctx = cv.getContext("2d");
    ctx.scale(r, r);
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15,39,64,.88)"; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = "#e0a93b"; ctx.stroke();
    ctx.fillStyle = "#f4c867";
    ctx.font = `800 ${n < 100 ? 15 : 13}px "M PLUS 1p", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, size / 2, size / 2 + 1);
    const url = cv.toDataURL();
    clusterIconCache.set(k, url);
    return url;
  }

  /** まとめた丸を押したら、その範囲へズーム */
  function zoomToCluster(entities) {
    if (S.busy) return;
    const now = S.viewer.clock.currentTime;
    const pts = entities.map(e => e.position && e.position.getValue(now)).filter(Boolean);
    if (!pts.length) return;
    stopOrbit();
    const bs = C.BoundingSphere.fromPoints(pts);
    flySphereP(bs.center, new C.HeadingPitchRange(0, toRad(-60), Math.max(bs.radius * 3.2, 15000)), { duration: 1.6 });
  }

  function renderPins() {
    const ents = S.ds.entities;
    ents.suspendEvents();               // 1,000件以上でも一括で追加
    ents.removeAll();
    S.entities.clear();
    const pointSize = IS_MOBILE ? 10 : 12;
    S.spots.forEach(sp => {
      const e = ents.add({
        position: C.Cartesian3.fromDegrees(sp.lng, sp.lat, 0),
        point: {
          pixelSize: pointSize, color: S.visits.has(sp.spot_id) ? COLOR_VISITED : COLOR_PIN,
          outlineColor: C.Color.WHITE, outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY   // 地表への貼り付け計算をしない（軽量化）
        },
        label: {
          text: pinLabel(sp),
          font: `700 ${IS_MOBILE ? 12 : 14}px "M PLUS 1p", sans-serif`,
          fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true, backgroundColor: C.Color.fromCssColorString("rgba(15,39,64,.75)"),
          backgroundPadding: new C.Cartesian2(5, 3),
          pixelOffset: new C.Cartesian2(0, IS_MOBILE ? -18 : -22),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: LABEL_NEAR
        }
      });
      e.spot = sp;
      e._mode = "normal";
      S.entities.set(sp.spot_id, e);
    });
    ents.resumeEvents();
    applyPinVisibility();
  }

  /** sp を渡すとそのピンだけ表示、null で全ピンを表示 */
  function showOnlyPin(sp) {
    const ents = S.ds.entities;
    ents.suspendEvents();
    S.entities.forEach((e, id) => {
      const show = !sp || id === sp.spot_id;
      if (e.show !== show) e.show = show;
    });
    ents.resumeEvents();
    // 1件だけ表示するときはクラスタを止めて、確実にピンと名前を出す
    S.ds.clustering.enabled = !sp;
    S.viewer.scene.requestRender();
  }

  /**
   * ピンの表示ルール
   *  - 飛行中：目的地だけ
   *  - 「目的地のみ」ON で到着後：いまいるスポットだけ
   *  - 上空待機中（全体を見る・テーマ切替直後）：すべて（行き先を選べるように）
   */
  function applyPinVisibility() {
    if (S.flyingTo) return showOnlyPin(S.flyingTo);
    if (S.pinFocus && S.current) return showOnlyPin(S.current);
    showOnlyPin(null);
  }

  function updatePinsBtn() {
    const b = $("#btnPins");
    b.textContent = S.pinFocus ? "📍 目的地のみ" : "📍 すべて表示";
    b.setAttribute("aria-pressed", String(S.pinFocus));
  }

  function pinLabel(sp) { return S.visits.has(sp.spot_id) ? `✔ ${sp.name}` : sp.name; }

  function setPin(sp, mode) {
    const e = S.entities.get(sp.spot_id);
    if (!e) return;
    const visited = S.visits.has(sp.spot_id);
    const sig = mode + (visited ? "v" : "");
    if (e._mode === sig) return;          // 変化がなければ何もしない（1,000件以上でも軽く）
    e._mode = sig;
    e.label.text = pinLabel(sp);
    const base = IS_MOBILE ? 10 : 12;
    const style = {
      normal: [base, visited ? COLOR_VISITED : COLOR_PIN],
      hi: [base + 14, COLOR_HI],
      current: [base + 6, COLOR_CUR]
    }[mode];
    e.point.pixelSize = style[0];
    e.point.color = style[1];
    // 光っている・いる場所の名前は遠くからでも表示
    e.label.distanceDisplayCondition = mode === "normal" ? LABEL_NEAR : undefined;
    S.viewer.scene.requestRender();
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
    S.flyingTo = sp;
    applyPinVisibility();   // 飛行中は目的地以外のピンを隠す
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
    S.flyingTo = null;
    S.current = sp;
    applyPinVisibility();
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

    showOnlyPin(null);   // ルーレット中は全ピンを表示
    S.ds.clustering.enabled = false;   // 光るピンが見えるよう、まとめ表示を一時停止
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
    $("#cardTheme").innerHTML = `${iconHtml(th.icon)} ${esc(th.theme_name || "")}`;
    $("#cardName").textContent = sp.name;
    $("#cardCoords").textContent = `${sp.lat.toFixed(4)}, ${sp.lng.toFixed(4)}　高度 ${Math.round(sp.altitude || 0)} m`;
    $("#cardTags").innerHTML = String(sp.tags || "").split(",").map(t => t.trim()).filter(Boolean)
      .map(t => `<span class="tag">${esc(t)}</span>`).join("");

    const body = $("#cardBody");
    if (mode === "preview") {
      body.innerHTML = `
        <button class="btn-fly" id="btnFlyHere">ここへ飛ぶ！</button>
        <div id="cardVisit" style="margin-top:12px"></div>
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
          ${S.current && S.current.spot_id === sp.spot_id ? `<button class="chip-btn" id="btnLand">🛬 降りる（ストリートビュー）</button>` : ""}
          <button class="chip-btn" id="btnOrbit">🔄 旋回</button>
          ${sp.video_url ? `<button class="chip-btn" id="btnVideo">🎬 空撮映像</button>` : ""}
        </div>
        <div id="cardVisit"></div>
        ${wikiHtml}
        <div class="card-section-title">次のフライト候補</div>
        <div class="next-list">
          ${nexts.map(n => `<button class="next-btn" data-id="${esc(n.p.spot_id)}">${esc(n.p.name)}<small>約${Math.round(n.d).toLocaleString()} km</small></button>`).join("")}
        </div>`;
      $("#btnReplay").addEventListener("click", () => { Voice.reset(); Voice.say(comment || sp.eagle_comment || sp.name); });
      if ($("#btnLand")) $("#btnLand").addEventListener("click", () => landAt(sp));
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
    S.cardSpot = sp;
    renderCardVisit(sp);
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
      S.themes.map(t => `<option value="${esc(t.theme_id)}" ${t.theme_id === sel ? "selected" : ""}>${esc(iconText(t.icon))}${esc(t.theme_name)}</option>`).join("") +
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
  const M = { themeId: "", batch: "all", spots: [], sel: new Set(), isAdmin: false, newIcon: "", pendingIcons: [] };

  function bindManageUI() {
    $("#btnManage").addEventListener("click", openManage);
    $("#btnManageMenu").addEventListener("click", openManage);
    $("#manageClose").addEventListener("click", closeManage);
    // アイコン：絵文字の入力
    $("#mgThemeList").addEventListener("input", e => {
      if (!e.target.classList.contains("mg-icon")) return;
      const row = e.target.closest(".mg-theme-row");
      row.dataset.icon = e.target.value.trim() || "📍";
      $(".mg-ico-prev", row).innerHTML = iconHtml(row.dataset.icon);
    });
    // アイコン：画像の選択
    $("#mgThemeList").addEventListener("change", async e => {
      if (!e.target.classList.contains("mg-ico-file")) return;
      const file = e.target.files[0];
      e.target.value = "";
      const row = e.target.closest(".mg-theme-row");
      const icon = await uploadIconFile(file, e.target.closest(".mg-ico-pick"));
      if (!icon) return;
      row.dataset.icon = icon;
      $(".mg-icon", row).value = "";
      $(".mg-ico-prev", row).innerHTML = iconHtml(icon);
      showToast("画像を選びました。「保存」を押すと確定します");
    });
    $("#newThemeIcon").addEventListener("input", e => {
      M.newIcon = "";
      $("#newIconPreview").innerHTML = iconHtml(e.target.value.trim() || "📍");
    });
    $("#newIconFile").addEventListener("change", async e => {
      const file = e.target.files[0];
      e.target.value = "";
      const icon = await uploadIconFile(file, e.target.closest(".mg-ico-pick"));
      if (!icon) return;
      M.newIcon = icon;
      $("#newThemeIcon").value = "";
      $("#newIconPreview").innerHTML = iconHtml(icon);
    });
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

  /** 画像を正方形256pxに切り抜いてアップロード → "img:ID" を返す */
  async function uploadIconFile(file, pick) {
    if (!file) return "";
    if (pick) pick.classList.add("busy");
    try {
      const blob = await resizeIcon(file);
      const data = await blobToBase64(blob);
      const r = await Api.call("uploadPhoto", { data, mime: blob.type, kind: "icon" });
      M.pendingIcons.push(r.photo_id);
      return "img:" + r.photo_id;
    } catch (e) {
      showToast(e.message || "画像を読み込めませんでした", 5000);
      return "";
    } finally {
      if (pick) pick.classList.remove("busy");
    }
  }

  async function resizeIcon(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) {
      src = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error("この形式の画像は読み込めません（JPEG・PNGをお使いください）"));
        img.src = URL.createObjectURL(file);
      });
    }
    const size = 256, side = Math.min(src.width, src.height);
    const sx = (src.width - side) / 2, sy = (src.height - side) / 2;
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, sx, sy, side, side, 0, 0, size, size);
    if (src.close) src.close();
    let blob = await new Promise(res => cv.toBlob(res, "image/png"));        // 透過を保つPNG
    if (blob.size > 250 * 1024) blob = await new Promise(res => cv.toBlob(res, "image/webp", 0.9));
    return blob;
  }

  /** 閉じるとき、選んだが保存しなかったアイコン画像を片付ける */
  async function closeManage() {
    $("#manageModal").classList.add("hidden");
    const used = new Set(S.themes.map(t => t.icon).filter(isImgIcon).map(i => i.slice(4)));
    const unused = M.pendingIcons.filter(id => !used.has(id));
    M.pendingIcons = [];
    M.newIcon = "";
    $("#newIconPreview").innerHTML = iconHtml($("#newThemeIcon").value.trim() || "📍");
    if (unused.length) Api.call("deletePhotos", { photo_ids: unused }).catch(() => {});
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
      <div class="mg-theme-row" data-id="${esc(t.theme_id)}" data-icon="${esc(t.icon || "📍")}">
        <label class="mg-ico-pick ${t.can_edit ? "" : "disabled"}" title="${t.can_edit ? "画像をアイコンにする" : ""}">
          <span class="mg-ico-prev">${iconHtml(t.icon)}</span>
          <span class="mg-ico-cam" aria-hidden="true">📷</span>
          <input type="file" class="mg-ico-file" accept="image/*" hidden ${t.can_edit ? "" : "disabled"}>
        </label>
        <input type="text" class="mg-icon" maxlength="8" value="${isImgIcon(t.icon) ? "" : esc(t.icon || "📍")}" placeholder="絵文字" aria-label="アイコン（絵文字）" ${t.can_edit ? "" : "disabled"}>
        <input type="text" class="mg-tname" maxlength="30" value="${esc(t.theme_name)}" aria-label="カテゴリ名" ${t.can_edit ? "" : "disabled"}>
        ${t.can_edit
          ? `<button class="chip-btn" data-act="rename">保存</button>
             <button class="chip-btn danger" data-act="delete">削除</button>`
          : `<span class="mg-lock" style="grid-column: span 2">🔒 変更できません</span>`}
      </div>`).join("");
    $("#mgTheme").innerHTML = S.themes.map(t =>
      `<option value="${esc(t.theme_id)}">${esc(iconText(t.icon))}${esc(t.theme_name)}</option>`).join("");
    if (M.themeId) $("#mgTheme").value = M.themeId;
  }

  async function addTheme() {
    const theme_name = $("#newThemeName").value.trim();
    const icon = M.newIcon || $("#newThemeIcon").value.trim() || "📍";
    if (!theme_name) return showToast("新しいカテゴリ名を入力してください");
    showLoading("カテゴリを追加中…");
    try {
      const r = await Api.call("saveTheme", { theme: { theme_name, icon } });
      S.themes.push(r.theme);
      S.spotsCache[r.theme.theme_id] = [];
      $("#newThemeName").value = ""; $("#newThemeIcon").value = "";
      M.newIcon = "";
      $("#newIconPreview").innerHTML = iconHtml("📍");
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
      const icon = row.dataset.icon || "📍";
      if (!theme_name) return showToast("カテゴリ名を入力してください");
      showLoading("カテゴリを保存中…");
      try {
        await Api.call("updateTheme", { theme_id: id, theme_name, icon });
        theme.theme_name = theme_name; theme.icon = icon;
        renderThemeTabs();
        renderManageThemes();
        if (S.cardSpot && S.themeId === id && !$("#spotCard").classList.contains("hidden")) $("#cardTheme").innerHTML = `${iconHtml(icon)} ${esc(theme_name)}`;
        showToast("カテゴリを保存しました");
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

  /* =========================================================
   * 行ったところ（チェック・メモ・写真）
   * ========================================================= */
  const PHOTO_MAX_EDGE = 1600;     // 長辺の最大px
  const PHOTO_QUALITY = 0.82;      // JPEG画質
  const PHOTO_TARGET_BYTES = 600 * 1024;
  const MAX_PHOTOS = 6;
  const E = { visit: null, spot: null, photos: [], newIds: [], uploading: 0 }; // 編集中の状態
  const PV = { list: [], i: 0, caption: "" };

  const photoUrl = (id, w = 400) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${w}`;
  const photoImg = (id, w, alt = "") =>
    `<img src="${photoUrl(id, w)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='https://lh3.googleusercontent.com/d/${esc(id)}=w${w}'">`;
  const fmtDay = d => (d ? d.replace(/-/g, "/") : "");
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  function bindVisitUI() {
    $("#btnVisited").addEventListener("click", openVisitedList);
    $("#visitedClose").addEventListener("click", () => $("#visitedModal").classList.add("hidden"));
    $("#visitedFilter").addEventListener("change", renderVisitedList);
    $("#visitedSort").addEventListener("change", renderVisitedList);
    $("#visitedSummary").addEventListener("click", e => {
      const b = e.target.closest("[data-theme]");
      if (!b) return;
      $("#visitedFilter").value = b.dataset.theme;
      renderVisitedList();
    });
    $("#visitedList").addEventListener("click", onVisitedListClick);

    $("#visitClose").addEventListener("click", closeVisitEditor);
    $("#visitSave").addEventListener("click", saveVisitEditor);
    $("#visitDelete").addEventListener("click", () => E.visit && removeVisit(E.visit, true));
    $("#visitFile").addEventListener("change", e => { addPhotos([...e.target.files]); e.target.value = ""; });
    $("#visitPhotos").addEventListener("click", e => {
      const del = e.target.closest(".vp-del");
      if (del) {
        const id = del.dataset.id;
        E.photos = E.photos.filter(p => p.id !== id);
        renderEditorPhotos();
        return;
      }
      const img = e.target.closest(".vp[data-id]");
      if (img) openViewer(E.photos.filter(p => p.id).map(p => p.id), E.photos.findIndex(p => p.id === img.dataset.id), E.spot ? E.spot.name : "");
    });

    // 写真ビューア
    $("#pvClose").addEventListener("click", closeViewer);
    $("#pvPrev").addEventListener("click", () => stepViewer(-1));
    $("#pvNext").addEventListener("click", () => stepViewer(1));
    $("#photoViewer").addEventListener("click", e => { if (e.target.id === "photoViewer") closeViewer(); });
    document.addEventListener("keydown", e => {
      if ($("#photoViewer").classList.contains("hidden")) return;
      if (e.key === "ArrowLeft") stepViewer(-1);
      if (e.key === "ArrowRight") stepViewer(1);
      if (e.key === "Escape") closeViewer();
    });
  }

  async function loadVisits() {
    try {
      const r = await Api.call("getVisits");
      S.visits = new Map((r.visits || []).map(v => [v.spot_id, v]));
      S.themeTotals = r.theme_totals || {};
    } catch (e) {
      debugLog("visits load failed", e);
    }
  }

  function findSpot(spotId) {
    for (const id in S.spotsCache) {
      const sp = (S.spotsCache[id] || []).find(p => p.spot_id === spotId);
      if (sp) return sp;
    }
    return null;
  }

  function afterVisitChange(spotId) {
    const sp = S.spots.find(p => p.spot_id === spotId);
    if (sp) setPin(sp, S.current && S.current.spot_id === spotId ? "current" : "normal");
    if (S.cardSpot && S.cardSpot.spot_id === spotId && !$("#spotCard").classList.contains("hidden")) renderCardVisit(S.cardSpot);
    if (!$("#visitedModal").classList.contains("hidden")) renderVisitedList();
  }

  /* ---------- カード内の表示 ---------- */
  function renderCardVisit(sp) {
    const box = $("#cardVisit");
    if (!box) return;
    const v = S.visits.get(sp.spot_id);
    if (!v) {
      box.className = "visit-block";
      box.innerHTML = `<button class="btn-visit" id="btnCheckVisit">☐ 行ったところにチェック</button>`;
      $("#btnCheckVisit").addEventListener("click", () => quickCheck(sp));
      return;
    }
    box.className = "visit-block done";
    const ids = v.photo_ids || [];
    box.innerHTML = `
      <div class="visit-badge">✅ 行った！ ${esc(fmtDay(v.visited_on))}</div>
      ${ids.length ? `<div class="visit-thumbs">${ids.slice(0, 4).map((id, i) =>
        i === 3 && ids.length > 4
          ? `<button data-i="3" class="more" aria-label="写真をすべて見る">+${ids.length - 3}</button>`
          : `<button data-i="${i}" aria-label="写真を拡大">${photoImg(id, 300, sp.name)}</button>`).join("")}</div>` : ""}
      ${v.memo ? `<p class="visit-memo">${esc(v.memo)}</p>` : ""}
      <div class="card-actions" style="margin:6px 0 0">
        <button class="chip-btn" id="btnEditVisit">✏️ ${ids.length || v.memo ? "記録を編集" : "写真・メモを追加"}</button>
        <button class="chip-btn danger" id="btnUncheckVisit">チェックを外す</button>
      </div>`;
    $$(".visit-thumbs button", box).forEach(b => b.addEventListener("click", () => openViewer(ids, +b.dataset.i, sp.name)));
    $("#btnEditVisit").addEventListener("click", () => openVisitEditor(sp, v));
    $("#btnUncheckVisit").addEventListener("click", () => removeVisit(v, false));
  }

  async function quickCheck(sp) {
    const btn = $("#btnCheckVisit");
    if (btn) { btn.disabled = true; btn.textContent = "記録中…"; }
    try {
      const r = await Api.call("saveVisit", { spot_id: sp.spot_id, visited_on: today() });
      S.visits.set(sp.spot_id, r.visit);
      afterVisitChange(sp.spot_id);
      Voice.say(pickOne([
        `おお、${sp.name}に行ったことがあるのか！さすがだな！思い出の写真もワシに見せてくれ！`,
        `${sp.name}、制覇だな！その時の写真があれば貼っておくのだぞ！`,
        `やるではないか！${sp.name}はワシも大好きな場所だぞ！`
      ]));
      showToast("行ったところにチェックしました");
    } catch (e) {
      showToast(e.message, 5000);
      if (btn) { btn.disabled = false; btn.textContent = "☐ 行ったところにチェック"; }
    }
  }

  async function removeVisit(v, fromEditor) {
    const n = (v.photo_ids || []).length;
    if (!confirm(`「${v.spot_name}」のチェックを外します。${n ? `\n写真${n}枚とメモも削除され、` : "\nメモも削除され、"}元に戻せません。よろしいですか？`)) return;
    showLoading("記録を削除中…");
    try {
      await Api.call("deleteVisit", { visit_id: v.visit_id });
      S.visits.delete(v.spot_id);
      if (fromEditor) { await discardNewPhotos(); hideVisitModal(); }
      afterVisitChange(v.spot_id);
      showToast("チェックを外しました");
    } catch (e) {
      showToast(e.message, 5000);
    } finally { hideLoading(); }
  }

  /* ---------- 記録の編集モーダル ---------- */
  function openVisitEditor(sp, v) {
    E.spot = sp; E.visit = v || null;
    E.photos = (v && v.photo_ids ? v.photo_ids : []).map(id => ({ id }));
    E.newIds = []; E.uploading = 0;
    $("#visitTitle").textContent = v ? "行ったところの記録を編集" : "行ったところを記録";
    $("#visitSpotName").textContent = sp.name || (v && v.spot_name) || "";
    $("#visitDate").value = (v && v.visited_on) || today();
    $("#visitDate").max = today();
    $("#visitMemo").value = (v && v.memo) || "";
    $("#visitDelete").classList.toggle("hidden", !v);
    renderEditorPhotos();
    $("#visitModal").classList.remove("hidden");
  }

  function hideVisitModal() { $("#visitModal").classList.add("hidden"); }

  async function closeVisitEditor() {
    if (E.uploading) return showToast("写真を送信中です。少しお待ちください");
    await discardNewPhotos();
    hideVisitModal();
  }

  /** 保存しなかった新しい写真をDriveから削除 */
  async function discardNewPhotos() {
    const unused = E.newIds.slice();
    E.newIds = [];
    if (unused.length) { try { await Api.call("deletePhotos", { photo_ids: unused }); } catch (e) { /* 次回で問題なし */ } }
  }

  function renderEditorPhotos() {
    $("#visitPhotos").innerHTML = E.photos.map(p => p.id
      ? `<div class="vp" data-id="${esc(p.id)}">${photoImg(p.id, 400)}<button type="button" class="vp-del" data-id="${esc(p.id)}" aria-label="この写真を外す">×</button></div>`
      : `<div class="vp">${p.preview ? `<img src="${p.preview}" alt="">` : ""}<span class="vp-state">${esc(p.state || "")}</span></div>`).join("");
    const full = E.photos.length >= MAX_PHOTOS;
    $("#visitAddPhoto").classList.toggle("hidden", full);
    $("#visitSave").disabled = E.uploading > 0;
  }

  async function addPhotos(files) {
    const room = MAX_PHOTOS - E.photos.length;
    if (room <= 0) return showToast(`写真は${MAX_PHOTOS}枚までです`);
    const list = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)).slice(0, room);
    if (files.length > room) showToast(`写真は${MAX_PHOTOS}枚までなので、${room}枚だけ追加します`);
    for (const f of list) {
      const slot = { id: "", state: "縮小中…", preview: "" };
      E.photos.push(slot);
      E.uploading++;
      renderEditorPhotos();
      try {
        const blob = await resizeImage(f);
        slot.preview = URL.createObjectURL(blob);
        slot.state = `送信中…（${Math.round(blob.size / 1024)}KB）`;
        renderEditorPhotos();
        const data = await blobToBase64(blob);
        const r = await Api.call("uploadPhoto", { data, mime: blob.type });
        if (E.photos.includes(slot)) {
          slot.id = r.photo_id;
          E.newIds.push(r.photo_id);
        } else {
          Api.call("deletePhotos", { photo_ids: [r.photo_id] }).catch(() => {});
        }
      } catch (e) {
        E.photos = E.photos.filter(p => p !== slot);
        showToast(e.message || "写真を読み込めませんでした", 5000);
      } finally {
        if (slot.preview) URL.revokeObjectURL(slot.preview);
        E.uploading--;
        renderEditorPhotos();
      }
    }
  }

  /** 長辺1600px以内・JPEGに縮小（大きすぎる場合は画質を下げて再圧縮） */
  async function resizeImage(file) {
    let src;
    try {
      src = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      src = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error("この形式の画像は読み込めません（JPEG・PNGをお使いください）"));
        img.src = URL.createObjectURL(file);
      });
    }
    const w0 = src.width, h0 = src.height;
    const encode = (edge, q) => {
      const scale = Math.min(1, edge / Math.max(w0, h0));
      const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);  // 透過PNG対策
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, w, h);
      return new Promise(res => cv.toBlob(res, "image/jpeg", q));
    };
    let blob = await encode(PHOTO_MAX_EDGE, PHOTO_QUALITY);
    if (blob.size > PHOTO_TARGET_BYTES) blob = await encode(PHOTO_MAX_EDGE, 0.72);
    if (blob.size > PHOTO_TARGET_BYTES * 1.5) blob = await encode(1280, 0.7);
    if (src.close) src.close();
    return blob;
  }

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = () => rej(new Error("画像の読み込みに失敗しました"));
      r.readAsDataURL(blob);
    });
  }

  async function saveVisitEditor() {
    if (E.uploading) return showToast("写真を送信中です。少しお待ちください");
    const visited_on = $("#visitDate").value || today();
    if (visited_on > today()) return showToast("行った日に未来の日付は選べません");
    showLoading("記録を保存中…");
    try {
      const r = await Api.call("saveVisit", {
        visit_id: E.visit ? E.visit.visit_id : "",
        spot_id: E.spot ? E.spot.spot_id : E.visit.spot_id,
        visited_on,
        memo: $("#visitMemo").value,
        photo_ids: E.photos.filter(p => p.id).map(p => p.id)
      });
      E.newIds = [];
      S.visits.set(r.visit.spot_id, r.visit);
      hideVisitModal();
      afterVisitChange(r.visit.spot_id);
      showToast("記録を保存しました");
    } catch (e) {
      showToast(e.message, 5000);
    } finally { hideLoading(); }
  }

  /* ---------- 行ったところリスト ---------- */
  async function openVisitedList() {
    $("#visitedModal").classList.remove("hidden");
    $("#visitedList").innerHTML = `<div class="visited-empty">読み込み中…</div>`;
    await loadVisits();   // 他の端末での変更も反映
    const sel = $("#visitedFilter").value || "all";
    $("#visitedFilter").innerHTML = `<option value="all">すべてのカテゴリ</option>` +
      S.themes.map(t => `<option value="${esc(t.theme_id)}">${esc(iconText(t.icon))}${esc(t.theme_name)}</option>`).join("");
    $("#visitedFilter").value = [...$("#visitedFilter").options].some(o => o.value === sel) ? sel : "all";
    renderVisitedList();
    S.spots.forEach(sp => setPin(sp, S.current && S.current.spot_id === sp.spot_id ? "current" : "normal"));
  }

  function renderVisitedList() {
    const all = [...S.visits.values()];
    const filter = $("#visitedFilter").value || "all";

    // カテゴリごとの達成状況
    const chips = S.themes.map(t => {
      const n = all.filter(v => v.theme_id === t.theme_id && v.spot_exists).length;
      const total = S.themeTotals[t.theme_id] || (S.spotsCache[t.theme_id] || []).length;
      const pct = total ? Math.round(n / total * 100) : 0;
      return `<button class="vs-chip ${filter === t.theme_id ? "active" : ""}" data-theme="${esc(t.theme_id)}">
        <b>${iconHtml(t.icon)} ${esc(t.theme_name)}</b><span>${n} / ${total} か所（${pct}%）</span>
        <div class="vs-bar"><i style="width:${pct}%"></i></div></button>`;
    });
    $("#visitedSummary").innerHTML =
      `<button class="vs-chip ${filter === "all" ? "active" : ""}" data-theme="all"><b>🌏 すべて</b><span>${all.length} か所</span></button>` + chips.join("");

    let list = filter === "all" ? all : all.filter(v => v.theme_id === filter);
    const sort = $("#visitedSort").value;
    list.sort((a, b) =>
      sort === "name" ? a.spot_name.localeCompare(b.spot_name, "ja")
        : sort === "old" ? (a.visited_on || "").localeCompare(b.visited_on || "")
          : (b.visited_on || "").localeCompare(a.visited_on || ""));

    if (!list.length) {
      $("#visitedList").innerHTML = `<div class="visited-empty">まだ記録がありません。<br>スポットのカードで「行ったところにチェック」を押してみましょう。</div>`;
      return;
    }
    const themeOf = id => S.themes.find(t => t.theme_id === id) || {};
    $("#visitedList").innerHTML = list.map(v => {
      const th = themeOf(v.theme_id);
      const ids = v.photo_ids || [];
      return `<div class="visited-item" data-spot="${esc(v.spot_id)}">
        <button class="vi-thumb" data-act="photos" ${ids.length ? "" : "disabled"} aria-label="写真を見る">${ids.length ? photoImg(ids[0], 200, v.spot_name) : iconHtml(th.icon)}</button>
        <div class="vi-body">
          <b>${esc(v.spot_name)}</b>${v.spot_exists ? "" : ` <small style="display:inline">（スポット削除済み）</small>`}
          <small>${th.theme_id ? iconHtml(th.icon) : ""} ${esc(th.theme_name || "")}・${esc(fmtDay(v.visited_on))}${ids.length ? `・📷${ids.length}枚` : ""}</small>
          ${v.memo ? `<p>${esc(v.memo)}</p>` : ""}
        </div>
        <div class="vi-actions">
          <button class="chip-btn" data-act="fly" ${v.spot_exists ? "" : "disabled"}>🦅 飛ぶ</button>
          <button class="chip-btn" data-act="edit">✏️ 編集</button>
          <button class="chip-btn danger" data-act="delete">削除</button>
        </div>
      </div>`;
    }).join("");
  }

  async function onVisitedListClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const spotId = btn.closest(".visited-item").dataset.spot;
    const v = S.visits.get(spotId);
    if (!v) return;
    const act = btn.dataset.act;
    if (act === "photos") return openViewer(v.photo_ids, 0, v.spot_name);
    if (act === "delete") return removeVisit(v, false);
    if (act === "edit") {
      const sp = findSpot(spotId) || { spot_id: spotId, name: v.spot_name };
      return openVisitEditor(sp, v);
    }
    if (act === "fly") {
      if (S.busy) return showToast("飛行中だ！少し待て！");
      $("#visitedModal").classList.add("hidden");
      if (v.theme_id !== S.themeId) await selectTheme(v.theme_id, true);
      const sp = S.spots.find(p => p.spot_id === spotId);
      if (!sp) return showToast("スポットが見つかりませんでした");
      Voice.reset();
      Voice.say(`思い出の${sp.name}へもう一度飛ぶぞ！`);
      flyToSpot(sp);
    }
  }

  /* ---------- 写真ビューア ---------- */
  function openViewer(ids, i, caption) {
    if (!ids || !ids.length) return;
    PV.list = ids; PV.i = Math.max(0, i); PV.caption = caption || "";
    showViewer();
    $("#photoViewer").classList.remove("hidden");
  }
  function showViewer() {
    const id = PV.list[PV.i];
    const img = $("#pvImg");
    img.onerror = () => { img.onerror = null; img.src = `https://lh3.googleusercontent.com/d/${id}=w1600`; };
    img.referrerPolicy = "no-referrer";
    img.src = photoUrl(id, 1600);
    img.alt = PV.caption;
    $("#pvCaption").textContent = `${PV.caption}　${PV.i + 1} / ${PV.list.length}`;
    $("#pvPrev").classList.toggle("hidden", PV.list.length < 2);
    $("#pvNext").classList.toggle("hidden", PV.list.length < 2);
  }
  function stepViewer(d) {
    PV.i = (PV.i + d + PV.list.length) % PV.list.length;
    showViewer();
  }
  function closeViewer() { $("#photoViewer").classList.add("hidden"); $("#pvImg").src = ""; }

  /* =========================================================
   * 着陸 → ストリートビュー → 空へ戻る
   * ========================================================= */
  const SV = { spot: null, pano: null, panoLatLng: null, heading: 0, gm: null };
  let gmapsPromise = null;

  /** Maps JavaScript API（ストリートビュー）を必要なときだけ読み込む */
  function loadStreetViewLib() {
    const key = APP_CONFIG.GOOGLE_MAPS_API_KEY;
    if (!key) return Promise.reject(new Error("NO_KEY"));
    if (!gmapsPromise) {
      gmapsPromise = new Promise((resolve, reject) => {
        window.__eagleGmInit = async () => {
          try { resolve(await google.maps.importLibrary("streetView")); }
          catch (e) { reject(e); }
        };
        window.gm_authFailure = () => reject(new Error("AUTH"));
        const sc = document.createElement("script");
        sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=ja&region=JP&loading=async&callback=__eagleGmInit`;
        sc.async = true;
        sc.onerror = () => reject(new Error("LOAD"));
        document.head.appendChild(sc);
        setTimeout(() => reject(new Error("TIMEOUT")), 15000);
      }).catch(e => { gmapsPromise = null; throw e; });
    }
    return gmapsPromise;
  }

  /** 目的地の近くのストリートビューを探す（近い順に半径を広げる） */
  async function findPanorama(sp) {
    const lib = await loadStreetViewLib();
    SV.gm = lib;
    const svc = new lib.StreetViewService();
    for (const radius of [80, 300, 1000, 3000]) {
      try {
        const { data } = await svc.getPanorama({
          location: { lat: sp.lat, lng: sp.lng }, radius,
          preference: lib.StreetViewPreference.NEAREST
        });
        if (data && data.location) {
          const ll = data.location.latLng;
          return { pano: data.location.pano, lat: ll.lat(), lng: ll.lng(), dist: Math.round(distanceKm(sp, { lat: ll.lat(), lng: ll.lng() }) * 1000) };
        }
      } catch (e) { /* この半径には無い → 広げる */ }
    }
    return null;
  }

  function mapsPanoUrl() {
    const p = SV.panoLatLng || SV.spot || {};
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}&heading=${Math.round(SV.heading)}&pitch=5`;
  }

  async function landAt(sp) {
    if (S.busy) return showToast("飛行中だ！少し待て！");
    if (!S.current || S.current.spot_id !== sp.spot_id) return;
    S.busy = true;
    setModeButtons(false);
    SV.spot = sp; SV.panoLatLng = null; SV.pano = null;
    stopOrbit(); hideCard(); closeVideo();

    Voice.reset();
    Voice.say(`よし、${sp.name}に着陸するぞ！ここからは自分の目で歩いて見てみろ！`);
    const panoP = findPanorama(sp).catch(e => ({ error: e }));

    // 降下：ストリートビューの地点（なければ目的地）の上空40mへ、目的地を向いて降りる
    document.body.classList.add("landing");
    Sfx.wind(true);
    const found = await Promise.race([panoP, sleep(4000).then(() => undefined)]);
    const p = found && !found.error ? found : null;
    const at = p || sp;
    const ground = await groundHeight(at);
    SV.heading = p ? bearing(p.lat, p.lng, sp.lat, sp.lng) : (+sp.heading || 0);
    await flyP({
      destination: C.Cartesian3.fromDegrees(at.lng, at.lat, ground + (p ? 40 : 150)),
      orientation: { heading: toRad(SV.heading), pitch: toRad(p ? -8 : -25), roll: 0 },
      duration: 3.2, easingFunction: C.EasingFunction.QUADRATIC_IN_OUT
    });
    Sfx.wind(false);

    const result = found === undefined ? await panoP : found;
    document.body.classList.remove("landing");
    document.body.classList.add("sv-mode");
    $("#svTitle").textContent = sp.name;
    $("#svOverlay").classList.remove("hidden");
    openPanorama(sp, result);
    S.busy = false;
  }

  function openPanorama(sp, r) {
    const box = $("#svPano");
    box.innerHTML = "";
    if (r && !r.error) {
      SV.panoLatLng = { lat: r.lat, lng: r.lng };
      SV.heading = bearing(r.lat, r.lng, sp.lat, sp.lng);
      $("#svNote").textContent = r.dist > 30 ? `目的地まで約${r.dist >= 1000 ? (r.dist / 1000).toFixed(1) + "km" : r.dist + "m"}の地点に着陸` : "目的地に着陸";
      SV.pano = new SV.gm.StreetViewPanorama(box, {
        pano: r.pano,
        pov: { heading: SV.heading, pitch: 5 },
        zoom: 0,
        addressControl: true,
        fullscreenControl: false,
        motionTracking: false,
        motionTrackingControl: false,
        showRoadLabels: true,
        enableCloseButton: false
      });
      $("#svFace").classList.remove("hidden");
      return;
    }
    SV.pano = null;
    $("#svFace").classList.add("hidden");
    const err = r && r.error ? r.error.message : "";
    if (err === "NO_KEY" || err === "AUTH" || err === "LOAD" || err === "TIMEOUT") {
      // APIが使えない場合：Maps Embed API で表示を試す
      const key = APP_CONFIG.GOOGLE_MAPS_API_KEY;
      if (key && err !== "NO_KEY") {
        $("#svNote").textContent = "簡易表示";
        box.innerHTML = `<iframe src="https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(key)}&location=${sp.lat},${sp.lng}&heading=${Math.round(+sp.heading || 0)}&pitch=5&fov=90&language=ja" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>`;
      } else {
        $("#svNote").textContent = "";
        box.innerHTML = `<div class="sv-msg">ストリートビューを表示するには、config.js に Google マップの APIキー（Maps JavaScript API を有効化）を設定してください。<br>「Googleマップで開く」からは今すぐ見られます。</div>`;
      }
      return;
    }
    $("#svNote").textContent = "";
    box.innerHTML = `<div class="sv-msg">この近くにはストリートビューが見つからなかった…。<br>「空へ戻る」で、もう一度ワシの背中に乗るのだ！</div>`;
    Voice.say("むむ、この辺りは地上の写真が無いようだ。空へ戻るとするか！");
  }

  function faceTarget() {
    if (!SV.pano || !SV.spot) return;
    const pos = SV.pano.getPosition();
    const h = pos ? bearing(pos.lat(), pos.lng(), SV.spot.lat, SV.spot.lng) : SV.heading;
    SV.pano.setPov({ heading: h, pitch: 5 });
  }

  async function takeOff() {
    if (S.busy) return;
    const sp = SV.spot || S.current;
    $("#svOverlay").classList.add("hidden");
    document.body.classList.remove("sv-mode");
    if (SV.pano) { SV.pano.setVisible(false); SV.pano = null; }
    $("#svPano").innerHTML = "";
    if (!sp) return;
    S.busy = true;
    Voice.reset();
    Voice.say("よし、空へ戻るぞ！しっかり掴まっておれ！");
    document.body.classList.add("flying");
    Sfx.wind(true);
    const view = await spotView(sp);
    await flySphereP(view.target, view.offset, { duration: 3, easingFunction: C.EasingFunction.QUADRATIC_OUT });
    document.body.classList.remove("flying");
    Sfx.wind(false);
    startOrbit(view);
    S.busy = false;
    setModeButtons(true);
    showCard(sp, "arrived", await getComment(sp));
  }

  /* ---------- 公開 ---------- */
  window.App = { start };
})();
