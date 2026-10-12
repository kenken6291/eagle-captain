/**
 * =========================================================
 * 鷲の目紀行（イーグル隊長の空中散歩）  — GASバックエンド
 *  - 会員認証（仮パスワード発行・強制変更・再発行・セッション）
 *  - テーマ／スポットCRUD
 *  - Gemini API（スポット生成・クイズ・解説・TTS）プロキシ
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   GEMINI_API_KEY : 必須  Gemini APIキー
 *   GOOGLE_MAPS_API_KEY : 推奨  Google マップのAPIキー（フォトリアル3D・ストリートビュー用）。
 *                         ログイン済みの会員のブラウザにだけ渡します
 *   GEMINI_MODEL   : 任意  既定 gemini-2.5-flash
 *   TTS_MODEL      : 任意  既定 gemini-2.5-flash-preview-tts
 *   TTS_VOICE      : 任意  既定 Orus（低めで張りのある男性系）
 *   SPREADSHEET_ID : 任意  スタンドアロンGASの場合のみ
 *   ADMIN_EMAILS   : 推奨  管理者のメールアドレス（カンマ区切り）。全カテゴリ・全スポットを編集／削除可能
 *   TTS_FOLDER_ID  : 自動  TTSキャッシュ用Driveフォルダ（初回自動作成）
 *   PHOTO_FOLDER_ID: 自動  「行ったところ」写真用Driveフォルダ（初回自動作成）
 * =========================================================
 */

const SHEETS = { USERS: "Users", THEMES: "Themes", SPOTS: "Spots", SESSIONS: "Sessions", VISITS: "Visits" };
const HEADERS = {
  Users: ["user_id", "email", "display_name", "password_hash", "status", "created_at", "last_login_at"],
  Themes: ["theme_id", "theme_name", "icon", "default_center", "created_by"],
  Spots: ["spot_id", "theme_id", "name", "lat", "lng", "altitude", "heading", "pitch", "video_url", "eagle_comment", "tags", "created_by", "import_batch"],
  Sessions: ["token_hash", "user_id", "created_at", "expires_at"],
  Visits: ["visit_id", "user_id", "spot_id", "theme_id", "spot_name", "visited_on", "memo", "photo_ids", "created_at", "updated_at"]
};
const TZ = "Asia/Tokyo";
const SESSION_DAYS = 30;
const APP_NAME = "鷲の目紀行";

const CAPTAIN_SYSTEM = [
  "あなたは空中遊覧ツアーを率いる「イーグル隊長」です。",
  "ユーザーを背に乗せて上空から日本や世界の絶景を案内しています。",
  "【口調ルール】",
  "- 一人称は「ワシ（鷲にかけたダジャレ）」",
  "- 語尾は「〜だ！」「〜ぞ！」「〜だな！」と豪快で熱い口調。",
  "- 空からの高度感や風の気流を感じさせる表現を織り交ぜる。",
  "- 指定されたスポットについて、短くワクワクする解説（100文字程度）を行え。",
  "- 事実に自信のないことは断定しない。"
].join("\n");

/* =========================================================
 * エントリポイント
 * ========================================================= */
function doGet() {
  return json_({ ok: true, app: APP_NAME, time: now_() });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, code: "BAD_REQUEST", message: "リクエストの形式が正しくありません" });
  }

  try {
    const action = req.action;
    const publicActions = { register: register_, login: login_, resetPassword: resetPassword_ };
    if (publicActions[action]) return json_(publicActions[action](req));

    // 以降はログイン必須
    const ctx = authenticate_(req.token);
    const user = ctx.user;

    if (action === "me") return json_({ ok: true, user: publicUser_(user), mustChange: user.status === "TEMP" });
    if (action === "logout") { deleteSession_(req.token); return json_({ ok: true }); }
    if (action === "changePassword") return json_(changePassword_(user, req));

    // 仮パスワード状態では変更以外を受け付けない
    if (user.status !== "ACTIVE") {
      return json_({ ok: false, code: "MUST_CHANGE", message: "新しいパスワードを設定してください" });
    }

    const actions = {
      getClientConfig: getClientConfig_,
      getThemes: getThemes_,
      updateTheme: updateTheme_,
      deleteTheme: deleteTheme_,
      getManageData: getManageData_,
      deleteSpots: deleteSpots_,
      getVisits: getVisits_,
      saveVisit: saveVisit_,
      deleteVisit: deleteVisit_,
      uploadPhoto: uploadPhoto_,
      deletePhotos: deletePhotos_,
      getSpots: getSpots_,
      saveTheme: saveTheme_,
      saveSpots: saveSpots_,
      generateSpots: generateSpots_,
      quiz: quiz_,
      explain: explain_,
      tts: tts_
    };
    if (!actions[action]) return json_({ ok: false, code: "UNKNOWN", message: "不明な操作です: " + action });
    return json_(actions[action](req, user));
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, code: err.code || "ERROR", message: err.message || String(err) });
  }
}

/* =========================================================
 * 初期セットアップ（エディタから1回実行）
 * ========================================================= */
function setup() {
  const ss = ss_();
  Object.keys(HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
    ensureHeaders_(name);
  });
  // 緯度経度などを文字列化させない
  ss.getSheetByName(SHEETS.SPOTS).getRange("D:H").setNumberFormat("0.######");

  seedIfEmpty_();

  // 権限承認を一度に済ませる
  ss.getSheetByName(SHEETS.VISITS).getRange("F:F").setNumberFormat("@"); // 日付を文字列のまま保存
  GmailApp.getAliases();
  ttsFolder_();
  photoFolder_();
  Logger.log("セットアップ完了: " + ss.getUrl());
}

function seedIfEmpty_() {
  const th = sheet_(SHEETS.THEMES);
  if (th.getLastRow() <= 1) {
    th.getRange(2, 1, 3, 4).setValues([
      ["world_heritage", "世界遺産巡り", "🌍", "20,40,2"],
      ["world_heritage_jp", "日本の世界遺産", "⛩️", "36.2,138.2,5"],
      ["japan_castles", "日本のお城巡り", "🏯", "35.0,135.5,5"]
    ]);
  }
  const sp = sheet_(SHEETS.SPOTS);
  if (sp.getLastRow() > 1) return;
  const rows = [
    // 世界遺産
    ["s_wh_001", "world_heritage", "マチュ・ピチュ", -13.1631, -72.5450, 900, 200, -25, "", "雲の上の空中都市だ！アンデスの尾根にしがみつく石の街、ワシも気流に乗らねば辿り着けん絶景だぞ！", "ペルー,遺跡,インカ"],
    ["s_wh_002", "world_heritage", "ギザの三大ピラミッド", 29.9792, 31.1342, 900, 210, -25, "", "砂漠の熱い上昇気流に乗ってピラミッド上空だ！四千年以上も立ち続ける石の山、空から見ると見事な三角形だぞ！", "エジプト,古代,遺跡"],
    ["s_wh_003", "world_heritage", "モン・サン＝ミシェル", 48.6361, -1.5115, 600, 160, -22, "", "海に浮かぶ修道院だ！潮が満ちれば島、引けば陸続き。ワシの翼でぐるりと一周するぞ！", "フランス,修道院,海"],
    ["s_wh_004", "world_heritage", "万里の長城（八達嶺）", 40.3599, 116.0200, 800, 300, -25, "", "山の尾根をうねる石の大蛇だな！ワシの目でも端が見えんほど長いぞ！しっかり掴まっておれ！", "中国,城壁,遺跡"],
    ["s_wh_005", "world_heritage", "タージ・マハル", 27.1751, 78.0421, 600, 180, -25, "", "白い大理石の霊廟だ！朝日に染まる姿は空から見ても格別。左右対称の庭園もよく見えるぞ！", "インド,霊廟,建築"],
    ["s_wh_006", "world_heritage", "アンコール・ワット", 13.4125, 103.8670, 900, 90, -28, "", "密林の中に浮かぶ巨大寺院だ！堀に囲まれた回廊の幾何学模様、上空からしか拝めん眺めだぞ！", "カンボジア,寺院,遺跡"],
    ["s_wh_007", "world_heritage", "グランド・キャニオン", 36.1069, -112.1129, 3500, 20, -20, "", "大地の裂け目に急降下だ！川が削った地層の縞模様、ワシの翼でも端から端まで一苦労だぞ！", "アメリカ,自然,渓谷"],
    // 日本の世界遺産
    ["s_jp_001", "world_heritage_jp", "富士山", 35.3606, 138.7274, 6000, 0, -18, "", "日本一の霊峰だ！山頂の上昇気流は手ごわいぞ、しっかり掴まっておれ！火口までよく見えるな！", "静岡,山梨,自然,文化遺産"],
    ["s_jp_002", "world_heritage_jp", "厳島神社", 34.2959, 132.3199, 500, 320, -25, "", "海に浮かぶ朱の社殿だ！満ち潮の大鳥居を空から拝めるのはワシの背中の特権だぞ！", "広島,神社,海"],
    ["s_jp_003", "world_heritage_jp", "白川郷", 36.2574, 136.9063, 600, 200, -28, "", "合掌造りの集落だ！三角屋根が肩を寄せ合う山里、雪の季節なら絵本の世界だぞ！", "岐阜,集落,合掌造り"],
    ["s_jp_004", "world_heritage_jp", "日光東照宮", 36.7581, 139.5988, 500, 0, -30, "", "杉木立の奥に輝く極彩色の社殿だ！上空から見ると山に抱かれた配置がよくわかるぞ！", "栃木,神社,文化遺産"],
    ["s_jp_005", "world_heritage_jp", "法隆寺", 34.6147, 135.7346, 450, 180, -30, "", "現存する世界最古級の木造建築だ！千三百年の風雪に耐えた五重塔、ワシも頭が下がるぞ！", "奈良,寺院,文化遺産"],
    ["s_jp_006", "world_heritage_jp", "屋久島", 30.3580, 130.5290, 5000, 200, -20, "", "苔と巨木の島だ！海からいきなりそびえる山々に雲がまとわりつく、気流が荒いぞ！", "鹿児島,島,自然遺産"],
    // 日本のお城
    ["s_ca_001", "japan_castles", "姫路城", 34.8394, 134.6939, 350, 330, -25, "", "白鷺城とも呼ばれる名城だ！白漆喰の天守が空に映えるぞ！", "国宝,世界遺産,兵庫"],
    ["s_ca_002", "japan_castles", "松本城", 36.2386, 137.9689, 300, 300, -25, "", "黒い天守が北アルプスを背負って立つ！烏城の異名どおり、空から見ると凛々しいぞ！", "国宝,長野,現存天守"],
    ["s_ca_003", "japan_castles", "彦根城", 35.2764, 136.2516, 350, 270, -25, "", "琵琶湖のほとりの国宝天守だ！湖からの風が心地よいぞ、ワシも羽を休めたいところだ！", "国宝,滋賀,現存天守"],
    ["s_ca_004", "japan_castles", "犬山城", 35.3884, 136.9393, 300, 180, -25, "", "木曽川の崖の上にそびえる天守だ！川面すれすれから一気に駆け上がるぞ！", "国宝,愛知,現存天守"],
    ["s_ca_005", "japan_castles", "松江城", 35.4750, 133.0507, 350, 200, -25, "", "水の都を見守る国宝天守だ！堀を巡る遊覧船も空から丸見えだぞ！", "国宝,島根,現存天守"],
    ["s_ca_006", "japan_castles", "大阪城", 34.6873, 135.5262, 450, 200, -25, "", "天下の名城だ！巨大な石垣と堀の広さ、空から見るとスケールが段違いだぞ！", "大阪,石垣,天守"],
    ["s_ca_007", "japan_castles", "熊本城", 32.8063, 130.7058, 400, 0, -25, "", "武者返しの石垣が見事な名城だ！復興した天守が空にそびえる姿、胸が熱くなるぞ！", "熊本,石垣,天守"]
  ];
  sp.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/* =========================================================
 * 認証
 * ========================================================= */
function register_(req) {
  const email = normEmail_(req.email);
  const name = String(req.display_name || "").trim().slice(0, 20);
  if (!isEmail_(email)) throw err_("メールアドレスの形式が正しくありません");
  if (!name) throw err_("ニックネームを入力してください");

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findUserByEmail_(email)) throw err_("このメールアドレスは登録済みです。パスワード再発行をご利用ください");
    const userId = "usr_" + Utilities.formatDate(new Date(), TZ, "yyyyMMddHHmmss") + Math.floor(Math.random() * 90 + 10);
    const temp = tempPassword_();
    sheet_(SHEETS.USERS).appendRow([userId, email, name, hash_(userId, temp), "TEMP", now_(), ""]);
    sendTempMail_(email, name, temp, false);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, message: "仮パスワードをメールで送信しました。メールに記載のパスワードでログインしてください。" };
}

function login_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || "");
  const u = findUserByEmail_(email);
  if (!u || u.password_hash !== hash_(u.user_id, pw)) throw err_("メールアドレスまたはパスワードが違います");

  sheet_(SHEETS.USERS).getRange(u._row, 7).setValue(now_());
  const token = createSession_(u.user_id);
  return { ok: true, token: token, user: publicUser_(u), mustChange: u.status === "TEMP" };
}

function changePassword_(user, req) {
  const current = String(req.current_password || "");
  const next = String(req.new_password || "");
  if (user.password_hash !== hash_(user.user_id, current)) throw err_("現在のパスワード（仮パスワード）が違います");
  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) throw err_("8文字以上で、英字と数字を両方含めてください");
  if (next === current) throw err_("現在と異なるパスワードを設定してください");

  const sh = sheet_(SHEETS.USERS);
  sh.getRange(user._row, 4, 1, 2).setValues([[hash_(user.user_id, next), "ACTIVE"]]);
  user.status = "ACTIVE";
  return { ok: true, user: publicUser_(user) };
}

function resetPassword_(req) {
  const email = normEmail_(req.email);
  const msg = "登録があるメールアドレスの場合、新しい仮パスワードを送信しました。";
  if (!isEmail_(email)) throw err_("メールアドレスの形式が正しくありません");
  const u = findUserByEmail_(email);
  if (!u) return { ok: true, message: msg }; // 登録有無を推測されないよう同じ応答
  const temp = tempPassword_();
  sheet_(SHEETS.USERS).getRange(u._row, 4, 1, 2).setValues([[hash_(u.user_id, temp), "TEMP"]]);
  sendTempMail_(email, u.display_name, temp, true);
  return { ok: true, message: msg };
}

function sendTempMail_(email, name, temp, isReset) {
  const subject = "【" + APP_NAME + "】" + (isReset ? "仮パスワード再発行" : "仮パスワードのお知らせ");
  const body = [
    name + " さん",
    "",
    isReset ? "パスワード再発行のご依頼を受け付けました。" : "ご登録ありがとうございます。イーグル隊長がお待ちしております！",
    "",
    "仮パスワード： " + temp,
    "",
    "ログイン後、新しいパスワードの設定画面が表示されます。",
    "お心当たりのない場合は、このメールを破棄してください。",
    "",
    "―― " + APP_NAME
  ].join("\n");
  GmailApp.sendEmail(email, subject, body, { name: APP_NAME });
}

function createSession_(userId) {
  const token = Utilities.getUuid() + "-" + Utilities.getUuid();
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000);
  sheet_(SHEETS.SESSIONS).appendRow([sha256_(token), userId, now_(), Utilities.formatDate(exp, TZ, "yyyy-MM-dd HH:mm:ss")]);
  return token;
}

function authenticate_(token) {
  if (!token) throw err_("ログインしてください", "AUTH");
  const th = sha256_(String(token));
  const sh = sheet_(SHEETS.SESSIONS);
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][0] === th) {
      const exp = parseDate_(values[i][3]);
      if (exp && exp.getTime() < Date.now()) {
        sh.deleteRow(i + 1);
        throw err_("ログインの有効期限が切れました", "AUTH");
      }
      const u = findUserById_(values[i][1]);
      if (!u) throw err_("会員情報が見つかりません", "AUTH");
      return { user: u };
    }
  }
  throw err_("ログインしてください", "AUTH");
}

function deleteSession_(token) {
  if (!token) return;
  const th = sha256_(String(token));
  const sh = sheet_(SHEETS.SESSIONS);
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][0] === th) sh.deleteRow(i + 1);
  }
}

/** 期限切れセッションの掃除（任意：時間主導トリガーで1日1回など） */
function cleanupSessions() {
  const sh = sheet_(SHEETS.SESSIONS);
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    const exp = parseDate_(values[i][3]);
    if (exp && exp.getTime() < Date.now()) sh.deleteRow(i + 1);
  }
}

function findUserByEmail_(email) {
  return findUser_(r => String(r[1]).toLowerCase() === email);
}
function findUserById_(id) {
  return findUser_(r => r[0] === id);
}
function findUser_(pred) {
  const values = sheet_(SHEETS.USERS).getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (pred(values[i])) {
      const r = values[i];
      return { _row: i + 1, user_id: r[0], email: r[1], display_name: r[2], password_hash: r[3], status: r[4] };
    }
  }
  return null;
}
function publicUser_(u) {
  return { user_id: u.user_id, email: u.email, display_name: u.display_name, status: u.status, is_admin: isAdmin_(u) };
}
function isAdmin_(u) {
  const list = prop_("ADMIN_EMAILS").toLowerCase().split(",").map(x => x.trim()).filter(x => x);
  return !!u && list.indexOf(String(u.email).toLowerCase()) >= 0;
}
/** カテゴリアイコン：絵文字 または "img:ドライブのファイルID" */
function isImgIcon_(icon) { return /^img:[\w-]{10,}$/.test(String(icon || "")); }
function normIcon_(icon, user, current) {
  const s = String(icon || "").trim();
  if (isImgIcon_(s)) {
    if (s === current) return s;  // 変更なし
    if (!ownPhoto_(s.slice(4), user)) throw err_("アイコン画像を確認できませんでした。もう一度選んでください");
    return s;
  }
  return s.slice(0, 16) || "📍";
}

/** 管理者、または作成者本人なら編集可 */
function canEdit_(user, createdBy) {
  return isAdmin_(user) || (!!createdBy && createdBy === user.user_id);
}

/* =========================================================
 * テーマ・スポット
 * ========================================================= */
/** ブラウザで使う設定（ログイン済み会員のみ） */
function getClientConfig_() {
  return { ok: true, google_maps_api_key: prop_("GOOGLE_MAPS_API_KEY") };
}

function getThemes_(req, user) {
  const themes = rows_(SHEETS.THEMES).filter(t => t.theme_id).map(t => ({
    theme_id: t.theme_id, theme_name: t.theme_name, icon: t.icon, default_center: t.default_center,
    can_edit: canEdit_(user, t.created_by)
  }));
  return { ok: true, themes: themes };
}

function getSpots_(req) {
  const id = String(req.theme_id || "");
  const spots = rows_(SHEETS.SPOTS)
    .filter(s => s.spot_id && s.theme_id === id)
    .map(normalizeSpot_)
    .filter(s => s);
  return { ok: true, spots: spots };
}

function saveTheme_(req, user) {
  const t = req.theme || {};
  let id = String(t.theme_id || "").trim();
  const name = String(t.theme_name || "").trim().slice(0, 30);
  if (!id) id = "t_" + Utilities.formatDate(new Date(), TZ, "yyyyMMddHHmmss"); // 省略時は自動採番
  if (!/^[a-z0-9_]{2,40}$/.test(id)) throw err_("テーマIDは半角小文字英数と_で入力してください");
  if (!name) throw err_("カテゴリ名を入力してください");
  ensureHeaders_(SHEETS.THEMES);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const themes = rows_(SHEETS.THEMES);
    if (themes.some(x => x.theme_id === id)) throw err_("そのテーマIDは既に使われています");
    if (themes.some(x => String(x.theme_name).trim() === name)) throw err_("同じ名前のカテゴリが既にあります");
    const theme = {
      theme_id: id, theme_name: name, icon: normIcon_(t.icon, user, ""),
      default_center: String(t.default_center || ""), created_by: user.user_id
    };
    appendObj_(SHEETS.THEMES, theme);
    return { ok: true, theme: { theme_id: id, theme_name: name, icon: theme.icon, default_center: theme.default_center, can_edit: true } };
  } finally {
    lock.releaseLock();
  }
}

/** カテゴリ名・アイコンの変更 */
function updateTheme_(req, user) {
  const id = String(req.theme_id || "");
  const name = String(req.theme_name || "").trim().slice(0, 30);
  if (!name) throw err_("カテゴリ名を入力してください");
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SHEETS.THEMES);
    const values = sh.getDataRange().getValues();
    const head = values[0];
    const cId = head.indexOf("theme_id"), cName = head.indexOf("theme_name"), cIcon = head.indexOf("icon"), cBy = head.indexOf("created_by");
    let row = -1;
    for (let i = 1; i < values.length; i++) {
      if (values[i][cId] === id) row = i;
      else if (String(values[i][cName]).trim() === name) throw err_("同じ名前のカテゴリが既にあります");
    }
    if (row < 0) throw err_("カテゴリが見つかりません");
    if (!canEdit_(user, cBy >= 0 ? values[row][cBy] : "")) throw err_("このカテゴリを変更する権限がありません", "FORBIDDEN");
    const oldIcon = String(values[row][cIcon] || "");
    const icon = normIcon_(req.icon, user, oldIcon);
    sh.getRange(row + 1, cName + 1).setValue(name);
    sh.getRange(row + 1, cIcon + 1).setValue(icon);
    if (oldIcon !== icon && isImgIcon_(oldIcon)) trashPhoto_(oldIcon.slice(4), user); // 古いアイコン画像を片付け
    return { ok: true, theme: { theme_id: id, theme_name: name, icon: icon } };
  } finally {
    lock.releaseLock();
  }
}

/** カテゴリ削除（中のスポットもまとめて削除） */
function deleteTheme_(req, user) {
  const id = String(req.theme_id || "");
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SHEETS.THEMES);
    const values = sh.getDataRange().getValues();
    const head = values[0];
    const cId = head.indexOf("theme_id"), cBy = head.indexOf("created_by");
    if (values.length <= 2) throw err_("カテゴリが1つしかないため削除できません");
    let row = -1;
    for (let i = 1; i < values.length; i++) if (values[i][cId] === id) row = i;
    if (row < 0) throw err_("カテゴリが見つかりません");
    if (!canEdit_(user, cBy >= 0 ? values[row][cBy] : "")) throw err_("このカテゴリを削除する権限がありません", "FORBIDDEN");
    const removed = rewriteRows_(SHEETS.SPOTS, r => r.theme_id !== id);
    const cIcon = head.indexOf("icon");
    const oldIcon = cIcon >= 0 ? String(values[row][cIcon] || "") : "";
    if (isImgIcon_(oldIcon)) trashPhoto_(oldIcon.slice(4), user);
    sh.deleteRow(row + 1);
    return { ok: true, deleted_spots: removed };
  } finally {
    lock.releaseLock();
  }
}

/** 管理画面用：カテゴリ内のスポット一覧（取り込み単位・削除可否つき） */
function getManageData_(req, user) {
  const id = String(req.theme_id || "");
  const spots = rows_(SHEETS.SPOTS).filter(s => s.spot_id && s.theme_id === id).map(s => ({
    spot_id: s.spot_id,
    name: s.name,
    batch: batchOf_(s),
    mine: !!s.created_by && s.created_by === user.user_id,
    can_delete: canEdit_(user, s.created_by)
  }));
  return { ok: true, is_admin: isAdmin_(user), spots: spots };
}

function batchOf_(s) {
  if (s.import_batch) return String(s.import_batch);
  const m = String(s.spot_id || "").match(/_(\d{14})_\d+$/); // 旧形式のIDから取り込み日時を復元
  return m ? m[1] : "";
}

/** スポットの一括削除 */
function deleteSpots_(req, user) {
  const ids = (req.spot_ids || []).map(String);
  if (!ids.length) throw err_("削除するスポットを選んでください");
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let denied = 0;
    const target = {};
    ids.forEach(id => { target[id] = true; });
    const removed = rewriteRows_(SHEETS.SPOTS, r => {
      if (!target[r.spot_id]) return true;
      if (!canEdit_(user, r.created_by)) { denied++; return true; }
      return false;
    });
    return { ok: true, deleted: removed, denied: denied };
  } finally {
    lock.releaseLock();
  }
}

function saveSpots_(req, user) {
  const themeId = String(req.theme_id || "");
  if (!rows_(SHEETS.THEMES).some(x => x.theme_id === themeId)) throw err_("保存先のテーマが見つかりません");
  const list = (req.spots || []).map(normalizeSpot_).filter(s => s);
  if (!list.length) throw err_("保存できるスポットがありません");
  ensureHeaders_(SHEETS.SPOTS);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const existing = rows_(SHEETS.SPOTS).filter(s => s.theme_id === themeId).map(s => String(s.name).trim());
    const stamp = Utilities.formatDate(new Date(), TZ, "yyyyMMddHHmmss");
    const objs = [];
    let skipped = 0;
    list.forEach((s, i) => {
      if (existing.indexOf(s.name) >= 0) { skipped++; return; }
      existing.push(s.name);
      objs.push({
        spot_id: "s_" + themeId + "_" + stamp + "_" + i, theme_id: themeId, name: s.name, lat: s.lat, lng: s.lng,
        altitude: s.altitude, heading: s.heading, pitch: s.pitch, video_url: s.video_url,
        eagle_comment: s.eagle_comment, tags: s.tags, created_by: user.user_id, import_batch: stamp
      });
    });
    if (objs.length) {
      const sh = sheet_(SHEETS.SPOTS);
      const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      const out = objs.map(o => head.map(h => (o[h] === undefined ? "" : o[h])));
      sh.getRange(sh.getLastRow() + 1, 1, out.length, head.length).setValues(out);
    }
    return { ok: true, saved: objs.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function normalizeSpot_(s) {
  const lat = Number(s.lat), lng = Number(s.lng);
  if (!s.name || isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const num = (v, d, a, b) => { const n = Number(v); return isNaN(n) || v === "" ? d : Math.min(b, Math.max(a, n)); };
  return {
    spot_id: String(s.spot_id || ""),
    theme_id: String(s.theme_id || ""),
    name: String(s.name).trim().slice(0, 60),
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    altitude: num(s.altitude, 400, 50, 20000),
    heading: num(s.heading, 0, 0, 360),
    pitch: num(s.pitch, -25, -89, -5),
    video_url: String(s.video_url || "").trim(),
    eagle_comment: String(s.eagle_comment || "").trim().slice(0, 200),
    tags: String(s.tags || "").trim().slice(0, 100)
  };
}


/* =========================================================
 * 行ったところ（チェック・メモ・写真）
 * ========================================================= */
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

function visitsSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEETS.VISITS);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.VISITS);
    sh.getRange(1, 1, 1, HEADERS.Visits.length).setValues([HEADERS.Visits]).setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.getRange("F:F").setNumberFormat("@");
  }
  return sh;
}

function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("PHOTO_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 作り直す */ }
  }
  const f = DriveApp.createFolder("eagle_captain_photos");
  props.setProperty("PHOTO_FOLDER_ID", f.getId());
  return f;
}

function fmtDay_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  const s = String(v || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}
function splitIds_(v) { return String(v || "").split(",").map(x => x.trim()).filter(x => x); }

function visitObj_(r, spotMap) {
  const sp = spotMap ? spotMap[r.spot_id] : null;
  return {
    visit_id: r.visit_id,
    spot_id: r.spot_id,
    theme_id: sp ? sp.theme_id : r.theme_id,
    spot_name: sp ? sp.name : r.spot_name,
    spot_exists: !!sp,
    visited_on: fmtDay_(r.visited_on),
    memo: String(r.memo || ""),
    photo_ids: splitIds_(r.photo_ids),
    created_at: String(r.created_at || ""),
    updated_at: String(r.updated_at || "")
  };
}

/** 自分の「行ったところ」一覧＋カテゴリ別スポット数 */
function getVisits_(req, user) {
  visitsSheet_();
  const spots = rows_(SHEETS.SPOTS).filter(s => s.spot_id);
  const spotMap = {};
  const totals = {};
  spots.forEach(s => { spotMap[s.spot_id] = s; totals[s.theme_id] = (totals[s.theme_id] || 0) + 1; });
  const visits = rows_(SHEETS.VISITS).filter(r => r.visit_id && r.user_id === user.user_id).map(r => visitObj_(r, spotMap));
  return { ok: true, visits: visits, theme_totals: totals };
}

/** 追加・更新（1スポットにつき1件） */
function saveVisit_(req, user) {
  const sh = visitsSheet_();
  const spotId = String(req.spot_id || "");
  const spot = rows_(SHEETS.SPOTS).filter(s => s.spot_id === spotId)[0];
  const day = fmtDay_(req.visited_on) || Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  const memo = String(req.memo || "").trim().slice(0, 500);
  const photoIds = (req.photo_ids || []).map(String).filter(x => x).slice(0, MAX_PHOTOS);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const values = sh.getDataRange().getValues();
    const head = values[0];
    const col = h => head.indexOf(h);
    let row = -1;
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (r[col("user_id")] !== user.user_id) continue;
      if ((req.visit_id && r[col("visit_id")] === req.visit_id) || (!req.visit_id && r[col("spot_id")] === spotId)) { row = i; break; }
    }
    if (req.visit_id && row < 0) throw err_("記録が見つかりません");
    if (row < 0 && !spot) throw err_("スポットが見つかりません");

    // 写真は本人がアップロードしたものだけ受け付ける
    photoIds.forEach(id => { if (!ownPhoto_(id, user)) throw err_("写真の保存に失敗しました。もう一度追加してください"); });

    const now = now_();
    if (row >= 0) {
      const r = values[row];
      const oldIds = splitIds_(r[col("photo_ids")]);
      oldIds.filter(id => photoIds.indexOf(id) < 0).forEach(id => trashPhoto_(id, user)); // 外した写真は削除
      r[col("visited_on")] = day;
      r[col("memo")] = memo;
      r[col("photo_ids")] = photoIds.join(",");
      r[col("updated_at")] = now;
      sh.getRange(row + 1, 1, 1, head.length).setValues([r]);
      const obj = {};
      head.forEach((h, i) => { obj[h] = r[i]; });
      return { ok: true, visit: visitObj_(obj, spot ? { [spot.spot_id]: spot } : null), created: false };
    }
    const obj = {
      visit_id: "v_" + Utilities.getUuid().slice(0, 13), user_id: user.user_id, spot_id: spotId,
      theme_id: spot.theme_id, spot_name: spot.name, visited_on: day, memo: memo,
      photo_ids: photoIds.join(","), created_at: now, updated_at: now
    };
    sh.appendRow(head.map(h => (obj[h] === undefined ? "" : obj[h])));
    return { ok: true, visit: visitObj_(obj, { [spot.spot_id]: spot }), created: true };
  } finally {
    lock.releaseLock();
  }
}

/** チェックを外す（写真も削除） */
function deleteVisit_(req, user) {
  const sh = visitsSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const values = sh.getDataRange().getValues();
    const head = values[0];
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (r[head.indexOf("visit_id")] === req.visit_id && r[head.indexOf("user_id")] === user.user_id) {
        splitIds_(r[head.indexOf("photo_ids")]).forEach(id => trashPhoto_(id, user));
        if (values.length === 2) sh.getRange(2, 1, 1, head.length).clearContent();
        else sh.deleteRow(i + 1);
        return { ok: true };
      }
    }
    throw err_("記録が見つかりません");
  } finally {
    lock.releaseLock();
  }
}

/** 写真アップロード（ブラウザ側で縮小済みのJPEG） */
function uploadPhoto_(req, user) {
  const mime = String(req.mime || "image/jpeg");
  if (["image/jpeg", "image/png", "image/webp"].indexOf(mime) < 0) throw err_("JPEG・PNG・WebPの画像を選んでください");
  const bytes = Utilities.base64Decode(String(req.data || ""));
  if (!bytes.length) throw err_("画像データがありません");
  if (bytes.length > MAX_PHOTO_BYTES) throw err_("画像が大きすぎます");
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const prefix = req.kind === "icon" ? "icon_" : "visit_";
  const name = prefix + user.user_id + "_" + Utilities.formatDate(new Date(), TZ, "yyyyMMddHHmmss") + "_" + Math.floor(Math.random() * 1000) + "." + ext;
  const file = photoFolder_().createFile(Utilities.newBlob(bytes, mime, name));
  file.setDescription("owner:" + user.user_id);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { console.warn(e); }
  return { ok: true, photo_id: file.getId(), size: bytes.length };
}

/** 保存せずに閉じたときなど、未使用の写真を削除 */
function deletePhotos_(req, user) {
  const used = {};
  rows_(SHEETS.VISITS).filter(r => r.user_id === user.user_id).forEach(r => splitIds_(r.photo_ids).forEach(id => { used[id] = true; }));
  rows_(SHEETS.THEMES).forEach(t => { if (isImgIcon_(t.icon)) used[String(t.icon).slice(4)] = true; }); // 使用中のアイコン
  let n = 0;
  (req.photo_ids || []).map(String).forEach(id => { if (!used[id] && trashPhoto_(id, user)) n++; });
  return { ok: true, deleted: n };
}

function ownPhoto_(id, user) {
  try { return DriveApp.getFileById(id).getDescription() === "owner:" + user.user_id; } catch (e) { return false; }
}
function trashPhoto_(id, user) {
  try {
    const f = DriveApp.getFileById(id);
    if (f.getDescription() !== "owner:" + user.user_id && !isAdmin_(user)) return false;
    f.setTrashed(true);
    return true;
  } catch (e) { return false; }
}

/* =========================================================
 * Gemini 連携
 * ========================================================= */
function generateSpots_(req) {
  // names があれば「名前リスト」モード、なければ「キーワード」モード
  const names = Array.isArray(req.names)
    ? req.names.map(n => String(n || "").trim().slice(0, 60)).filter(n => n).slice(0, 30)
    : null;
  const prompt = String(req.prompt || "").trim().slice(0, 300);
  if (names && !names.length) throw err_("スポット名を入力してください");
  if (!names && !prompt) throw err_("取り込みたい内容を入力してください");
  const count = names ? names.length : Math.min(10, Math.max(1, Number(req.count) || 5));

  const schema = {
    type: "OBJECT",
    properties: {
      spots: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            lat: { type: "NUMBER" },
            lng: { type: "NUMBER" },
            altitude: { type: "NUMBER" },
            heading: { type: "NUMBER" },
            pitch: { type: "NUMBER" },
            eagle_comment: { type: "STRING" },
            tags: { type: "STRING" }
          },
          required: ["name", "lat", "lng", "altitude", "heading", "pitch", "eagle_comment", "tags"]
        }
      }
    },
    required: ["spots"]
  };

  const intro = names
    ? [
        "次のスポット名の一覧について、それぞれの場所を特定してJSONで出力してください。",
        "一覧の順番どおりに1件ずつ出力し、実在の場所として特定できないものは出力しないでください。",
        "スポット名の一覧：",
        names.map((n, i) => (i + 1) + ". " + n).join("\n"),
        "name は一覧の表記を基本とし、地域名などの補足は外して正式名称に整えてください。"
      ]
    : [
        "次のリクエストに合う実在の観光スポットを" + count + "件、JSONで出力してください。",
        "リクエスト：" + prompt
      ];
  const text = intro.concat([
    req.theme_name ? "テーマ：" + req.theme_name : "",
    "",
    "各項目のルール：",
    "- name: 日本語の正式名称（Wikipediaの記事名に近い表記）",
    "- lat, lng: その場所の中心の正確な緯度・経度（小数点以下4桁以上）。不確かなスポットは含めない",
    "- altitude: 上空からの見下ろし高度(m)。建物・城・寺社は250〜600、街並みや島は800〜2000、山や渓谷は2000〜6000",
    "- heading: カメラの方位角 0〜360（被写体の正面や見栄えのよい方角）",
    "- pitch: カメラの傾斜角 -45〜-15",
    "- eagle_comment: イーグル隊長の口調で、そのスポットを上空から案内するセリフ（80〜100文字）",
    "- tags: 都道府県や国、種別などをカンマ区切りで3つ程度"
  ]).filter(Boolean).join("\n");

  const out = gemini_(text, schema, { system: CAPTAIN_SYSTEM, temperature: 0.4 });
  const spots = (out.spots || []).map(normalizeSpot_).filter(s => s);
  return { ok: true, spots: spots };
}

function quiz_(req) {
  const a = req.spotA || {}, b = req.spotB || {};
  if (!a.name || !b.name) throw err_("クイズの対象スポットが足りません");
  const schema = {
    type: "OBJECT",
    properties: {
      question: { type: "STRING" },
      optionA: { type: "STRING" },
      optionB: { type: "STRING" },
      answer: { type: "STRING", enum: ["A", "B"] },
      explanation: { type: "STRING" }
    },
    required: ["question", "optionA", "optionB", "answer", "explanation"]
  };
  const text = [
    "空中遊覧の行き先を決める「2択の豆知識クイズ」を1問作ってください。",
    "テーマ：" + (req.theme_name || ""),
    req.current_name ? "現在地：" + req.current_name : "現在地：上空",
    "選択肢Aのスポット：" + a.name + "（" + (a.tags || "") + "）",
    "選択肢Bのスポット：" + b.name + "（" + (b.tags || "") + "）",
    "",
    "ルール：",
    "- 問題は隊長の口調で、「〇〇なのはどっちだ？」の形にする（60文字以内）",
    "- optionA は必ずAのスポット名、optionB は必ずBのスポット名にする",
    "- 正解が一つに定まる、よく知られた事実だけを使う",
    "- answer は正解の記号（A か B）",
    "- explanation は隊長の口調で正解の理由を60文字以内で"
  ].join("\n");
  const q = gemini_(text, schema, { system: CAPTAIN_SYSTEM, temperature: 0.8 });
  q.answer = String(q.answer || "A").toUpperCase() === "B" ? "B" : "A";
  return { ok: true, quiz: q };
}

function explain_(req) {
  const name = String(req.name || "").slice(0, 60);
  if (!name) throw err_("スポット名がありません");
  const schema = { type: "OBJECT", properties: { comment: { type: "STRING" } }, required: ["comment"] };
  const text = "スポット「" + name + "」（" + (req.tags || "") + "、テーマ：" + (req.theme_name || "") +
    "）に到着しました。上空から案内するセリフを100文字程度で作ってください。";
  const out = gemini_(text, schema, { system: CAPTAIN_SYSTEM, temperature: 0.9 });
  return { ok: true, comment: String(out.comment || "").trim() };
}

/** Gemini テキスト生成（JSON出力） */
function gemini_(prompt, schema, opts) {
  opts = opts || {};
  const key = prop_("GEMINI_API_KEY");
  if (!key) throw err_("GEMINI_API_KEY がスクリプトプロパティに設定されていません");
  const model = prop_("GEMINI_MODEL") || "gemini-2.5-flash";
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature == null ? 0.9 : opts.temperature,
      responseMimeType: "application/json",
      responseSchema: schema
    }
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  const res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    console.error("Gemini error " + code + ": " + res.getContentText());
    throw err_(code === 429 ? "AIが混み合っています。少し待ってからお試しください" : "AIの呼び出しに失敗しました（" + code + "）", "GEMINI");
  }
  const data = JSON.parse(res.getContentText());
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map(p => p.text || "").join("").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw err_("AIの応答を読み取れませんでした", "GEMINI");
  }
}

/** Gemini TTS（Driveにキャッシュして同じセリフは再生成しない） */
function tts_(req) {
  const text = String(req.text || "").trim().slice(0, 400);
  if (!text) throw err_("読み上げるテキストがありません");
  const key = prop_("GEMINI_API_KEY");
  if (!key) throw err_("GEMINI_API_KEY がスクリプトプロパティに設定されていません");
  const model = prop_("TTS_MODEL") || "gemini-2.5-flash-preview-tts";
  const voice = prop_("TTS_VOICE") || "Orus";

  const cacheName = sha256_(model + "|" + voice + "|" + text).slice(0, 40) + ".json";
  const folder = ttsFolder_();
  const hit = folder.getFilesByName(cacheName);
  if (hit.hasNext()) {
    const o = JSON.parse(hit.next().getBlob().getDataAsString());
    return { ok: true, cached: true, mimeType: o.mimeType, data: o.data };
  }

  const body = {
    contents: [{ parts: [{ text: "低く張りのある声で、豪快かつ快活に、ベテラン飛行隊長のように勢いよく読み上げてください：\n" + text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error("TTS error " + res.getResponseCode() + ": " + res.getContentText());
    throw err_("音声の生成に失敗しました", "TTS");
  }
  const data = JSON.parse(res.getContentText());
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const audio = parts.filter(p => p.inlineData)[0];
  if (!audio) throw err_("音声データが返りませんでした", "TTS");

  const o = { mimeType: audio.inlineData.mimeType, data: audio.inlineData.data };
  try { folder.createFile(cacheName, JSON.stringify(o), "application/json"); } catch (e) { /* キャッシュ失敗は無視 */ }
  return { ok: true, cached: false, mimeType: o.mimeType, data: o.data };
}

function ttsFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("TTS_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 削除されていたら作り直す */ }
  }
  const f = DriveApp.createFolder("eagle_captain_tts_cache");
  props.setProperty("TTS_FOLDER_ID", f.getId());
  return f;
}

/* =========================================================
 * ユーティリティ
 * ========================================================= */
function ss_() {
  const id = prop_("SPREADSHEET_ID");
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw err_("シート「" + name + "」がありません。setup() を実行してください");
  return sh;
}
function rows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const head = values.shift() || [];
  return values.map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}
/** 見出し行に不足している列を右端へ追加（旧バージョンのシートを自動移行） */
function ensureHeaders_(name) {
  const sh = sheet_(name);
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  let col = head.filter(h => h).length ? lastCol : 0;
  HEADERS[name].forEach(h => {
    if (head.indexOf(h) < 0) { col++; sh.getRange(1, col).setValue(h).setFontWeight("bold"); }
  });
}

/** 1行をオブジェクトで追記（見出しの並びに合わせる） */
function appendObj_(name, obj) {
  const sh = sheet_(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(h => (obj[h] === undefined ? "" : obj[h])));
}

/** keep(row) が false の行を削除してシートを書き直す。削除件数を返す */
function rewriteRows_(name, keep) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return 0;
  const head = values[0];
  const body = values.slice(1);
  const kept = body.filter(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    return keep(o);
  });
  const removed = body.length - kept.length;
  if (!removed) return 0;
  sh.getRange(2, 1, body.length, head.length).clearContent();
  if (kept.length) sh.getRange(2, 1, kept.length, head.length).setValues(kept);
  // 空いた行を削除（見出し以外の行を全部消すとエラーになるため、空なら1行残す）
  const start = kept.length ? kept.length + 2 : 3;
  const count = body.length - kept.length - (kept.length ? 0 : 1);
  if (count > 0) sh.deleteRows(start, count);
  return removed;
}

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ""; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function now_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss"); }
function parseDate_(v) {
  if (v instanceof Date) return v;
  const s = String(v || "");
  if (!s) return null;
  const d = new Date(s.replace(/-/g, "/"));
  return isNaN(d.getTime()) ? null : d;
}
function normEmail_(e) { return String(e || "").trim().toLowerCase(); }
function isEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function err_(message, code) { const e = new Error(message); e.code = code || "ERROR"; return e; }

function sha256_(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}
/** user_id をソルトにしたSHA-256 */
function hash_(userId, pw) { return sha256_(userId + ":" + pw); }

function tempPassword_() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const len = 10;
  let s;
  do {
    s = "";
    for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  } while (!/\d/.test(s) || !/[A-Za-z]/.test(s));
  return s;
}

/* ---------- 動作テスト用（エディタから実行） ---------- */
function testGemini() {
  Logger.log(JSON.stringify(explain_({ name: "姫路城", tags: "国宝,兵庫", theme_name: "日本のお城巡り" })));
}
function testTts() {
  const r = tts_({ text: "しっかり掴まっておれ、出発だ！" });
  Logger.log(r.mimeType + " / " + r.data.length + " chars");
}
