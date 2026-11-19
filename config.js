
/* ThingSpeak設定。Supabaseの公開可能キーを設定してください。 */
window.MONITOR_CONFIG = {
  channelId: "3541401",
  readApiKey: "8YCJD14OU78DXBRG",
  refreshMs: 30000,
  historyResults: 100,
  supabaseUrl: "https://qxjfkrfodteixdquawfv.supabase.co/rest/v1/",
  supabaseAnonKey: "sb_publishable_d9Fb0ZIH2Fapk5Y7dYHkyw_XnNrstxs",
  supabaseBucket: "recordings",
  deviceSettingsTable: "device_settings",
  latestAudioPath: "latest.wav",
  audioRefreshMs: 60000,
  // Supabase Edge Function のURLとVAPID公開鍵をセットアップ手順に従って設定
  pushFunctionUrl: "https://xrmyhdtnlfhllfttujfg.supabase.co/functions/v1/indoor-push",
  vapidPublicKey: "BFi-9fYcMSwn9gRP16UhIRB4lFmxD84zxQn2SjXzjE9bf2mROMO0BAkJQTOdU-dpcF9BLcMuBfH-NWnt006Ws-g"
};
