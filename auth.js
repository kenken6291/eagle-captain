/* =========================================================
 * auth.js  — API通信・会員認証（登録／ログイン／強制PW変更／再発行）
 * ========================================================= */

/* ---------- 共通UIヘルパー ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let _toastTimer = null;
function showToast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function showLoading(text = "通信中…") { $("#loadingText").textContent = text; $("#loading").classList.remove("hidden"); }
function hideLoading() { $("#loading").classList.add("hidden"); }

function debugLog(...a) { if (APP_CONFIG.DEBUG_MODE) console.log("[eagle]", ...a); }

/* ---------- API（GAS） ---------- */
const Api = {
  token: localStorage.getItem(APP_CONFIG.STORAGE_KEY_TOKEN) || "",

  setToken(t) {
    this.token = t || "";
    if (t) localStorage.setItem(APP_CONFIG.STORAGE_KEY_TOKEN, t);
    else localStorage.removeItem(APP_CONFIG.STORAGE_KEY_TOKEN);
  },

  /** 失敗時は Error を投げる（err.code に GAS 側のコード） */
  async call(action, data = {}) {
    debugLog("→", action, data);
    let res;
    try {
      // text/plain にすることで CORS のプリフライトを回避
      const r = await fetch(APP_CONFIG.GAS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, token: this.token, ...data })
      });
      res = await r.json();
    } catch (e) {
      const err = new Error("サーバーに接続できませんでした。通信状況を確認してください。");
      err.code = "NETWORK";
      throw err;
    }
    debugLog("←", action, res);
    if (!res.ok) {
      const err = new Error(res.message || "エラーが発生しました");
      err.code = res.code || "ERROR";
      if (err.code === "AUTH") Auth.onSessionExpired();
      if (err.code === "MUST_CHANGE") Auth.openPwModal(true);
      throw err;
    }
    return res;
  }
};

/* ---------- 認証 ---------- */
const Auth = {
  user: null,
  _lastLoginPw: "",

  init() {
    // パスワード表示切り替え（目玉アイコン）
    $$(".pw-eye").forEach(btn => {
      btn.innerHTML = Auth.eyeIcon(false);
      btn.addEventListener("click", () => {
        const input = btn.parentElement.querySelector("input");
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.innerHTML = Auth.eyeIcon(show);
        btn.setAttribute("aria-label", show ? "パスワードを隠す" : "パスワードを表示");
      });
    });

    // タブ切り替え
    $$(".auth-tab").forEach(tab => tab.addEventListener("click", () => this.switchTab(tab.dataset.tab)));

    $("#formLogin").addEventListener("submit", e => { e.preventDefault(); this.login(); });
    $("#formRegister").addEventListener("submit", e => { e.preventDefault(); this.register(); });
    $("#formForgot").addEventListener("submit", e => { e.preventDefault(); this.forgot(); });
    $("#formPw").addEventListener("submit", e => { e.preventDefault(); this.changePassword(); });
    $("#pwClose").addEventListener("click", () => this.closePwModal());

    // ユーザーメニュー
    const btnUser = $("#btnUser"), dd = $("#userDropdown");
    btnUser.addEventListener("click", e => {
      e.stopPropagation();
      const open = dd.classList.toggle("hidden") === false;
      btnUser.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", () => { dd.classList.add("hidden"); btnUser.setAttribute("aria-expanded", "false"); });
    $("#btnLogout").addEventListener("click", () => this.logout());
    $("#btnChangePw").addEventListener("click", () => this.openPwModal(false));

    this.restore();
  },

  eyeIcon(open) {
    return open
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/><path d="M9.9 5.1A10.4 10.4 0 0112 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.4 8 2.9 10.2 2 12c1 2.5 5 7 10 7 1.7 0 3.2-.5 4.5-1.2"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  },

  switchTab(name) {
    $$(".auth-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
    $$(".auth-form").forEach(f => f.classList.toggle("hidden", f.dataset.panel !== name));
    this.msg("");
  },

  msg(text) { $("#authMsg").textContent = text; },

  validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); },

  /** 保存済みトークンでセッション復元 */
  async restore() {
    if (!Api.token) return this.showGate();
    showLoading("搭乗記録を確認中…");
    try {
      const res = await Api.call("me");
      hideLoading();
      this.user = res.user;
      if (res.mustChange) { this.showGate(); this.openPwModal(true); return; }
      this.enter();
    } catch (e) {
      hideLoading();
      Api.setToken("");
      this.showGate();
    }
  },

  showGate() { $("#authGate").classList.remove("hidden"); },

  async login() {
    const email = $("#loginEmail").value.trim().toLowerCase();
    const password = $("#loginPw").value;
    if (!this.validEmail(email) || !password) return this.msg("メールアドレスとパスワードを入力してください");
    showLoading("搭乗手続き中…");
    try {
      const res = await Api.call("login", { email, password });
      Api.setToken(res.token);
      this.user = res.user;
      this._lastLoginPw = password;
      $("#loginPw").value = "";
      if (res.mustChange) this.openPwModal(true);
      else this.enter();
    } catch (e) {
      this.msg(e.message);
    } finally { hideLoading(); }
  },

  async register() {
    const email = $("#regEmail").value.trim().toLowerCase();
    const display_name = $("#regName").value.trim();
    if (!this.validEmail(email)) return this.msg("メールアドレスの形式が正しくありません");
    if (!display_name) return this.msg("ニックネームを入力してください");
    showLoading("仮パスワードを発行中…");
    try {
      const res = await Api.call("register", { email, display_name });
      this.switchTab("login");
      $("#loginEmail").value = email;
      this.msg(res.message || "仮パスワードをメールで送信しました。");
    } catch (e) {
      this.msg(e.message);
    } finally { hideLoading(); }
  },

  async forgot() {
    const email = $("#forgotEmail").value.trim().toLowerCase();
    if (!this.validEmail(email)) return this.msg("メールアドレスの形式が正しくありません");
    showLoading("仮パスワードを再発行中…");
    try {
      const res = await Api.call("resetPassword", { email });
      this.switchTab("login");
      $("#loginEmail").value = email;
      this.msg(res.message);
    } catch (e) {
      this.msg(e.message);
    } finally { hideLoading(); }
  },

  /** forced=true: 初回ログイン時の強制変更（閉じられない） */
  openPwModal(forced) {
    this._forced = forced;
    $("#pwTitle").textContent = forced ? "新しいパスワードを設定" : "パスワード変更";
    $("#pwLead").classList.toggle("hidden", !forced);
    $("#pwClose").classList.toggle("hidden", forced);
    // 強制変更時は直前に入力した仮パスワードを「現在のパスワード」として使う
    const hideCurrent = forced && !!this._lastLoginPw;
    $("#pwCurrentRow").classList.toggle("hidden", hideCurrent);
    $("#pwCurrent").value = hideCurrent ? this._lastLoginPw : "";
    $("#pwNew").value = ""; $("#pwNew2").value = "";
    $("#pwMsg").textContent = "";
    $("#pwModal").classList.remove("hidden");
  },

  closePwModal() {
    if (this._forced) return; // 強制変更中は閉じられない
    $("#pwModal").classList.add("hidden");
  },

  async changePassword() {
    const current = $("#pwCurrent").value;
    const pw = $("#pwNew").value, pw2 = $("#pwNew2").value;
    const m = $("#pwMsg");
    if (!current) return (m.textContent = "現在のパスワード（仮パスワード）を入力してください");
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return (m.textContent = "8文字以上で、英字と数字を両方含めてください");
    if (pw !== pw2) return (m.textContent = "確認用のパスワードが一致しません");
    if (pw === current) return (m.textContent = "現在と異なるパスワードを設定してください");
    showLoading("パスワードを変更中…");
    try {
      const res = await Api.call("changePassword", { current_password: current, new_password: pw });
      this.user = res.user;
      this._lastLoginPw = "";
      const wasForced = this._forced;
      this._forced = false;
      $("#pwModal").classList.add("hidden");
      showToast("パスワードを変更しました");
      if (wasForced) this.enter();
    } catch (e) {
      m.textContent = e.message;
    } finally { hideLoading(); }
  },

  /** アプリ本体へ */
  enter() {
    $("#authGate").classList.add("hidden");
    $("#userName").textContent = this.user?.display_name || "搭乗者";
    if (window.App) window.App.start(this.user);
  },

  async logout() {
    try { await Api.call("logout"); } catch (e) { /* 失効済みでも続行 */ }
    Api.setToken("");
    location.reload();
  },

  onSessionExpired() {
    Api.setToken("");
    showToast("ログインの有効期限が切れました。もう一度ログインしてください。", 4000);
    setTimeout(() => location.reload(), 1500);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  document.title = APP_CONFIG.APP_TITLE;
  $("#versionBadge").textContent = APP_CONFIG.VERSION;
  $("#authVersion").textContent = `${APP_CONFIG.APP_TITLE}  ${APP_CONFIG.VERSION}`;
  Auth.init();
});
