// W-C0033-001 官方警特報：⚠️/ℹ️ 兩階段，以及不要跟現況確認講同一句話兩次
const { loadApp, evaluate, createChecker, AI_REPORT_IDS } = require('./harness');

const app = loadApp({ stubIds: [...AI_REPORT_IDS, 'modeBtn'], storage: true });
const {
  officialAlertClause, cctvConfirmationClause, buildWeatherAlerts,
  setAlerts, setCctvStates, DIRECTION_TOWNS,
} = evaluate(app, `
exports.officialAlertClause = officialAlertClause;
exports.cctvConfirmationClause = cctvConfirmationClause;
exports.buildWeatherAlerts = buildWeatherAlerts;
exports.DIRECTION_TOWNS = DIRECTION_TOWNS;
exports.setAlerts = (v) => { cachedWeatherAlerts = v; };
exports.setCctvStates = (v) => { cctvStates = v; };
`);

const check = createChecker();
const ALL = Object.keys(DIRECTION_TOWNS);

// 真實 W-C0033-001 的形狀：phenomena/significance 包在 info 底下，
// 不是掛在 hazard 物件最上層（這點踩過坑，用真實回應驗證過）
const hazard = (phenomena, significance) => ({ info: { phenomena, significance } });

// ── 兩階段嚴重度 ────────────────────────────────────────────────
setAlerts({ 嘉義縣: [hazard('大雨', '特報')] });
setCctvStates({});
let out = officialAlertClause(ALL);
check(out.startsWith('ℹ️'), 'alert with no gauge confirmation -> soft ℹ️ notice');
check(out.includes('大雨特報'), 'the CWA phenomena+significance text is passed through verbatim');
check(out.includes('建議留意天候變化'), 'soft notice tells the reader to keep an eye out, not to postpone');

setCctvStates({ 新港: 'raining' });
out = officialAlertClause(ALL);
check(out.startsWith('⚠️'), 'alert confirmed by a rain gauge -> hard ⚠️ warning');
check(out.includes('建議延後外出'), 'hard warning tells the reader to postpone');

setCctvStates({ 新港: 'wet' });
check(officialAlertClause(ALL).includes('近期已有降雨'), 'a wet (recently rained) gauge still confirms, with its own wording');

setCctvStates({ 新港: 'dry', 溪口: 'unknown' });
check(officialAlertClause(ALL).startsWith('ℹ️'), 'dry/unknown gauges do not upgrade the notice to a warning');

// 縣市有特報但完全沒有特報資料時不能亂報
setAlerts({});
setCctvStates({ 新港: 'raining' });
check(officialAlertClause(ALL) === null, 'no active alert -> null, a raining gauge alone never fabricates an alert');

// ── 這次修的重複句 ──────────────────────────────────────────────
// ①卡片裡 cctvConfirmationClause 跟 officialAlertClause 是各自獨立產生的。
// 兩邊都命中同一個正在下雨的鄉鎮時，同一句「雨量站顯示 新港 已在降雨，
// 建議延後外出」會在同一張卡出現兩次（8/27 實機截圖）。
setAlerts({ 嘉義縣: [hazard('大雨', '特報')] });
setCctvStates({ 新港: 'raining' });

const gaugeLine = cctvConfirmationClause(['新港']);
check(gaugeLine.includes('已在降雨') && gaugeLine.includes('建議延後外出'), 'sanity: the standalone gauge clause says exactly the sentence that was duplicated');

const withGauge = officialAlertClause(ALL, { suppressGaugeConfirm: true });
check(!withGauge.includes('雨量站顯示'), 'BUG FIX: with the standalone gauge line shown, the alert line drops its duplicate copy');
check(withGauge.startsWith('⚠️'), 'BUG FIX: suppressing the duplicate sentence does NOT downgrade the ⚠️ severity');
check(withGauge.includes('大雨特報'), 'BUG FIX: the alert itself is still reported');

const withoutGauge = officialAlertClause(ALL, { suppressGaugeConfirm: false });
check(withoutGauge.includes('雨量站顯示'), 'when no standalone gauge line is shown, the alert line keeps carrying that information');

// 沒有現況確認時，suppress 旗標不該有任何作用
setCctvStates({ 新港: 'dry' });
check(officialAlertClause(ALL, { suppressGaugeConfirm: true }) === officialAlertClause(ALL, { suppressGaugeConfirm: false }),
  'the flag only affects the confirmed branch — a soft ℹ️ notice is identical either way');

// ── buildWeatherAlerts 解析 ─────────────────────────────────────
const parsed = buildWeatherAlerts({
  location: [
    { locationName: '嘉義縣', hazardConditions: { hazards: [hazard('大雨', '特報')] } },
    { locationName: '雲林縣', hazardConditions: { hazards: [] } },
    { locationName: '臺北市' },
  ],
});
check(parsed['嘉義縣'].length === 1, 'buildWeatherAlerts keeps counties that have hazards');
check(parsed['雲林縣'] === undefined, 'a county with an empty hazards array is omitted, not stored as an empty alert');
check(parsed['臺北市'] === undefined, 'a county with no hazardConditions at all is omitted');
check(Object.keys(buildWeatherAlerts({})).length === 0, 'a response with no location array yields no alerts instead of throwing');
check(Object.keys(buildWeatherAlerts(null)).length === 0, 'a null response yields no alerts instead of throwing');

check.finish();
