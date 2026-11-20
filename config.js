/* =========================================================
 * 鷲の目紀行（イーグル隊長の空中散歩）  設定ファイル
 * ========================================================= */
const APP_CONFIG = {
  // GASウェブアプリのURL（デプロイ後の /exec で終わるURL）
  GAS_API_URL: "https://script.google.com/macros/s/AKfycbyg4n9zdoiuM1p0iCEb4t4KPjRfovJjeMAyZgHD_ClOcDyUsCBlaLbIIjKsjoCoziplTQ/exec",

  // ※ GitHub Pagesは誰でもソースを見られるため、Gemini APIキーはここに書かず
  //    GASの「スクリプト プロパティ」(GEMINI_API_KEY) に設定してください。
  //    Gemini呼び出し（スポット生成・クイズ・解説・TTS）はすべてGAS経由で行います。
  GEMINI_API_KEY: "",

  // Google マップ Platform の APIキーは、GASの「スクリプト プロパティ」
  //   GOOGLE_MAPS_API_KEY に設定します（ログイン後にGASから受け取ります）。
  //   ここは空のままにしてください。
  GOOGLE_MAPS_API_KEY: "",

  // 任意：Cesium ion のアクセストークン。設定すると3D地形＋3D建物が有効になります。
  //       空のままでも航空写真（Esri World Imagery）で動作します。
  CESIUM_ION_TOKEN: "",

  VERSION: "v1.10.0",
  APP_TITLE: "鷲の目紀行",
  APP_SUBTITLE: "イーグル隊長の空中散歩",
  DEBUG_MODE: false,

  // 既定のGeminiモデル（ユーザーが画面で選ばなかった時に使う）
  //   空文字 "" = 自動（GASのスクリプトプロパティ GEMINI_MODEL → 汎用の最新モデル）
  GEMINI_MODEL: "",

  // 画面の「AIモデル」選択肢（value がAPIのモデルID）
  //   指定モデルに該当がない（廃止・未公開・名前違い）場合は、GAS側で汎用の最新モデルへ自動で切り替わります
  GEMINI_MODEL_OPTIONS: [
    { value: "",                  label: "自動モード（汎用の最新）" },
    { value: "gemini-4-hydrogen", label: "4 Hydrogen（日々の暮らしをサポート）" },
    { value: "gemini-4-neon",     label: "4 Neon（Deeper analysis）" },
    { value: "gemini-4-carbon",   label: "4 Carbon（Code & complex work）" },
    { value: "gemini-4-argon",    label: "4 Argon" },
    { value: "gemini-3.8-flash",  label: "3.8 Flash" },
    { value: "gemini-3.5-flash",  label: "3.5 Flash" }
  ],

  // 隊長ボイス: "gemini"（Gemini TTS、失敗時ブラウザ音声）/ "browser"（ブラウザ音声のみ）
  VOICE_MODE: "gemini",

  // localStorageのキー
  STORAGE_KEY_TOKEN: "eagle_captain_token",
  STORAGE_KEY_THEME: "eagle_captain_theme",
  STORAGE_KEY_MUTE: "eagle_captain_mute",
  STORAGE_KEY_PINS: "eagle_captain_pins",
  STORAGE_KEY_MODEL: "eagle_captain_gemini_model"
};
