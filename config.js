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

  // Google マップ Platform の APIキー
  //   ・Map Tiles API        … 空から見下ろす「フォトリアル3D」
  //   ・Maps JavaScript API  … 着陸後のストリートビュー
  //   ・Maps Embed API       … ストリートビューの予備表示
  //   ※必ず「HTTPリファラー制限：https://kenken6291.github.io/*」と
  //     「API制限：上記3つのAPI」を付けたキーを使ってください。
  //   空のままだと航空写真（平面）で表示します。
  GOOGLE_MAPS_API_KEY: "",

  // 任意：Cesium ion のアクセストークン。設定すると3D地形＋3D建物が有効になります。
  //       空のままでも航空写真（Esri World Imagery）で動作します。
  CESIUM_ION_TOKEN: "",

  VERSION: "v1.7.0",
  APP_TITLE: "鷲の目紀行",
  APP_SUBTITLE: "イーグル隊長の空中散歩",
  DEBUG_MODE: false,

  // 隊長ボイス: "gemini"（Gemini TTS、失敗時ブラウザ音声）/ "browser"（ブラウザ音声のみ）
  VOICE_MODE: "gemini",

  // localStorageのキー
  STORAGE_KEY_TOKEN: "eagle_captain_token",
  STORAGE_KEY_THEME: "eagle_captain_theme",
  STORAGE_KEY_MUTE: "eagle_captain_mute",
  STORAGE_KEY_PINS: "eagle_captain_pins"
};
