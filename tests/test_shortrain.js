// F-B0046-001 短時雨勢預警：四態分類 + ±3 格鄰近搜尋
const { loadApp, evaluate, createChecker, AI_REPORT_IDS } = require('./harness');

const app = loadApp({
  stubIds: [...AI_REPORT_IDS, 'modeBtn', 'shortRainCard', 'srfSummaryBadge'],
  storage: true,
});
const {
  buildShortRainLayer, classifyShortRain, shortRainSummaryBadge, shortRainCellText,
  renderShortRainCard, gridIndexForCoord, FB0046_GRID, FALLBACK_TOWN_COORDS,
  setCachedShortRainLayer,
} = evaluate(app, `
exports.buildShortRainLayer = buildShortRainLayer;
exports.classifyShortRain = classifyShortRain;
exports.shortRainSummaryBadge = shortRainSummaryBadge;
exports.shortRainCellText = shortRainCellText;
exports.renderShortRainCard = renderShortRainCard;
exports.nearbyDistanceKm = nearbyDistanceKm;
exports.gridIndexForCoord = gridIndexForCoord;
exports.FB0046_GRID = FB0046_GRID;
exports.FALLBACK_TOWN_COORDS = FALLBACK_TOWN_COORDS;
exports.setCachedShortRainLayer = (v) => { cachedShortRainLayer = v; };
`);

const check = createChecker();

const COORDS = Object.fromEntries(
  Object.entries(FALLBACK_TOWN_COORDS).map(([k, v]) => [k, { ...v, source: 'test' }])
);

// 造一整片 -99（氣象署的無回波標記），再在指定索引寫入真實值。
// 寫在「鄉鎮旁邊那一格」而不是鄉鎮自己那格，就是這批測試的重點。
function buildGrid(writes) {
  const values = new Array(FB0046_GRID.lonCount * FB0046_GRID.latCount).fill(-99);
  for (const [idx, v] of writes) values[idx] = v;
  return values.join(',');
}
const idxOf = (label) => gridIndexForCoord(COORDS[label].lat, COORDS[label].lon);

// ── 這次修掉的 bug ──────────────────────────────────────────────
// 民雄自己那格是 -99，但往東 2 格（約 2.6 公里）有 4.5mm。修好之前卡片
// 會說「沒雨」——searchNearbyValid 有算出這個鄰居，但結果只進了 debug
// 面板。這正是 8/22 的實機情況：雨量站全部說在下雨，這張卡全部說沒雨。
const nearbyGrid = buildGrid([[idxOf('民雄') + 2, 4.5]]);
const nearbyLayer = buildShortRainLayer(nearbyGrid, COORDS);
check(nearbyLayer['民雄'].status === 'nearby', 'BUG FIX: town cell is -99 but a neighbour has rain -> status "nearby", not "dry"');
check(shortRainCellText(nearbyLayer['民雄']).includes('附近有雨'), 'BUG FIX: the card text says 附近有雨 instead of 沒雨');
check(!shortRainCellText(nearbyLayer['民雄']).includes('沒雨'), 'BUG FIX: the old misleading 沒雨 wording is gone for this case');
check(nearbyLayer['民雄'].nearbyMm === 4.5, 'nearby carries the actual mm from the neighbouring cell');
check(Math.abs(nearbyLayer['民雄'].nearbyKm - 2.56) < 0.05, 'nearby distance converts 2 cells east to ~2.6 km (0.0125 deg lon at 23.5N)');
check(/約2\.6公里外/.test(shortRainCellText(nearbyLayer['民雄'])), 'the distance is shown so the user can judge whether 2.6 km away matters');

// 鄰近搜尋是逐地做的，不能把一地的雨外溢到其他地
check(nearbyLayer['北港'].status === 'dry', 'a town far from the rain stays dry (nearby search is per-town, not global)');

// ── 自己那格就有雨 ─────────────────────────────────────────────
const directLayer = buildShortRainLayer(buildGrid([[idxOf('新港'), 3.0]]), COORDS);
check(directLayer['新港'].status === 'rain', 'rain in the town own cell -> status "rain"');
check(directLayer['新港'].mm === 3.0 && shortRainCellText(directLayer['新港']) === '3.0 mm', 'rain cell shows the raw mm value');
check(directLayer['新港'].nearbyMm === null, 'a raining cell does not also report itself as a nearby cell');

// ── 真的沒雨 ───────────────────────────────────────────────────
const dryLayer = buildShortRainLayer(buildGrid([]), COORDS);
check(Object.values(dryLayer).every(c => c.status === 'dry'), 'all -99 everywhere -> every town dry');
check(shortRainCellText(dryLayer['新港']) === '沒雨', 'dry renders as 沒雨');

// 超出 ±3 格的雨不可以被說成「附近有雨」——修好一個誠實度問題，不能
// 反過來製造誇大
const farLayer = buildShortRainLayer(buildGrid([[idxOf('斗南') + 8, 9.9]]), COORDS);
check(farLayer['斗南'].status === 'dry', 'rain beyond the ±3 window is not claimed as 附近有雨');

// ── 資料異常 ───────────────────────────────────────────────────
check(classifyShortRain(undefined, null).status === 'broken', 'undefined raw value -> broken');
check(classifyShortRain(NaN, null).status === 'broken', 'NaN raw value -> broken');
check(shortRainCellText(classifyShortRain(NaN, null)) === '資料異常', 'broken renders as 資料異常, distinct from 沒雨');
check(classifyShortRain(NaN, { dRow: 0, dCol: 1, v: 5, dist: 1 }).status === 'broken',
  'a broken own-cell stays broken even when a neighbour has data — a bad grid index must not be masked by its neighbours');
check(buildShortRainLayer('', COORDS)['新港'] === undefined, 'empty content string yields an empty layer, not fabricated cells');

// ── 收合狀態徽章 ───────────────────────────────────────────────
const cell = (status, extra) => ({ status, mm: null, raw: -99, nearbyMm: null, nearbyKm: null, ...extra });

setCachedShortRainLayer({ a: cell('rain', { mm: 2 }), b: cell('dry') });
check(shortRainSummaryBadge().text === '有降雨，點開看看', 'badge: any town actually raining -> 有降雨');

setCachedShortRainLayer({ a: cell('nearby', { nearbyMm: 3, nearbyKm: 2 }), b: cell('dry') });
check(shortRainSummaryBadge().text === '附近有雨，點開看看', 'badge: only nearby rain -> its own softer wording, still worth opening');
check(shortRainSummaryBadge().cls === 'alert', 'badge: nearby rain still renders as an alert, not calm');

setCachedShortRainLayer({ a: cell('rain', { mm: 2 }), b: cell('nearby', { nearbyMm: 3, nearbyKm: 2 }) });
check(shortRainSummaryBadge().text === '有降雨，點開看看', 'badge: actual rain outranks nearby rain');

setCachedShortRainLayer({ a: cell('dry'), b: cell('dry') });
check(shortRainSummaryBadge().text === '目前無降雨預報' && shortRainSummaryBadge().cls === 'calm', 'badge: everything dry -> calm 目前無降雨預報');

setCachedShortRainLayer({ a: cell('dry'), b: cell('broken') });
check(shortRainSummaryBadge() === null, 'badge: dry mixed with broken draws no conclusion (no false confidence from partial data)');

setCachedShortRainLayer({});
check(shortRainSummaryBadge() === null, 'badge: empty layer -> no badge');

// ── 卡片端到端 ─────────────────────────────────────────────────
setCachedShortRainLayer(nearbyLayer);
renderShortRainCard();
const cardOut = app.elements.shortRainCard.innerHTML;
check(cardOut.includes('民雄') && cardOut.includes('附近有雨'), 'card renders 附近有雨 for the affected town');
check(cardOut.includes('is-nearby'), 'nearby rows get the is-nearby class so they stand out from 沒雨 rows');
check(app.elements.srfSummaryBadge.textContent === '（附近有雨，點開看看）', 'collapsed badge reflects the nearby state');

check.finish();
