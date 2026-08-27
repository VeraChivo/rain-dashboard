// ③日間注意：連續風險格合併成時段，以及時段文案
//
// 這張卡直接影響「幾點前要回家」，寫錯不會當掉、只會安靜地給錯建議，
// 所以斷言全部針對「講出來的那句話對不對」，不只驗資料結構
const { loadApp, evaluate, createChecker, AI_REPORT_IDS } = require('./harness');

const app = loadApp({ stubIds: [...AI_REPORT_IDS, 'modeBtn'], storage: true });
const {
  computeRiskPeriods, periodAlertText, renderAlertList, slotRiskInfo,
  getTodayRemainingSlotTimes, setWeatherLayers, DIRECTION_TOWNS,
} = evaluate(app, `
exports.computeRiskPeriods = computeRiskPeriods;
exports.periodAlertText = periodAlertText;
exports.renderAlertList = renderAlertList;
exports.slotRiskInfo = slotRiskInfo;
exports.getTodayRemainingSlotTimes = getTodayRemainingSlotTimes;
exports.DIRECTION_TOWNS = DIRECTION_TOWNS;
exports.setWeatherLayers = (v) => { cachedWeatherLayers = v; };
`);

const check = createChecker();
const ALL = Object.keys(DIRECTION_TOWNS);

// 固定基準日，避免測試在跨日或月底時自己漂掉
const BASE = new Date(2026, 7, 27, 9, 0, 0); // 2026-08-27 09:00
const at = (h) => new Date(2026, 7, 27, h, 0, 0);

// 每個方向鋪一條 3 小時一格的 risk 時間軸。
// riskyBy: { 小時: { 方向: signalLevel } }，沒列到的就是安全格
function setTimeline(hours, riskyBy) {
  const layers = {};
  for (const label of ALL) {
    layers[label] = {
      risk: hours.map(h => ({
        start: at(h),
        end: at(h + 3),
        signalLevel: (riskyBy[h] && riskyBy[h][label]) || 'stable',
      })),
    };
  }
  setWeatherLayers(layers);
}

const HOURS = [9, 12, 15, 18, 21];
const allTowns = (level) => Object.fromEntries(ALL.map(l => [l, level]));

// ── 單一風險格：不硬寫結束時間 ──────────────────────────────────
// 只有一格有風險時，我們並不知道雨什麼時候停——資料只說了那一格。
// 寫成「12:00～15:00」等於憑空發明一個結束時間
setTimeline(HOURS, { 12: allTowns('thunder') });
let periods = computeRiskPeriods(BASE);
check(periods.length === 1, 'a single risky slot produces one period');
check(periods[0].isSingle === true, 'it is marked as a single slot');

let t = periodAlertText(periods[0], BASE);
check(t.timeLabel === '12:00左右', 'single slot says 12:00左右 — no invented end time');
check(!t.timeLabel.includes('～'), 'single slot never renders a start～end range');
check(t.text === '全區域 可能出現雷陣雨', 'single slot wording is 可能出現 (possibility), not 機率增加');
check(t.advice === '建議12:00前完成戶外行程', 'single slot advice names the time to be home by');

// ── 連續多格合併 ───────────────────────────────────────────────
setTimeline(HOURS, { 12: allTowns('thunder'), 15: allTowns('thunder') });
periods = computeRiskPeriods(BASE);
check(periods.length === 1, 'two consecutive slots with the same affected towns merge into one period');
check(periods[0].isSingle === false, 'a merged period is not marked single');

t = periodAlertText(periods[0], BASE);
check(t.timeLabel === '12:00～15:00', 'merged period renders the real start～end range');
check(t.text === '全區域 雷陣雨機率增加', 'merged period wording is 機率增加 (sustained), distinct from a single slot');
check(t.advice.includes('12:00前完成'), 'merged advice still names when to be home by');
check(t.advice.includes('18:00後趨緩'), 'merged advice names when it eases, taken from the next safe slot');

// 後面沒有資料格時，不可以憑空說「幾點後趨緩」
setTimeline([9, 12, 15], { 12: allTowns('thunder'), 15: allTowns('thunder') });
t = periodAlertText(computeRiskPeriods(BASE)[0], BASE);
check(!t.advice.includes('趨緩'), 'with no slot after the risky run, the advice omits any 趨緩 claim rather than guessing');

// ── 受影響地點不同就不合併 ─────────────────────────────────────
// 12:00 全區域、15:00 只剩兩地，是兩件不同的事，合併會讓「全區域」
// 這個字擴張到它其實不成立的時段
setTimeline(HOURS, {
  12: allTowns('thunder'),
  15: { 民雄: 'thunder', 斗南: 'thunder' },
});
periods = computeRiskPeriods(BASE);
check(periods.length === 2, 'consecutive slots with different affected towns stay as two periods');
check(periodAlertText(periods[0], BASE).text.includes('全區域'), 'the first period keeps 全區域');
check(!periodAlertText(periods[1], BASE).text.includes('全區域'), 'the second period does NOT inherit 全區域 — only two towns are affected');
check(/民雄|斗南/.test(periodAlertText(periods[1], BASE).text), 'the second period names the towns actually affected');

// ── 中間有安全格就斷開 ─────────────────────────────────────────
setTimeline(HOURS, { 12: allTowns('thunder'), 18: allTowns('thunder') });
periods = computeRiskPeriods(BASE);
check(periods.length === 2, 'a safe slot between two risky ones breaks them into separate periods');
check(periods.every(p => p.isSingle), 'each side of the gap is its own single slot, not one long merged range');

// ── 最嚴重的訊號決定用詞 ───────────────────────────────────────
setTimeline(HOURS, { 12: { ...allTowns('rain'), 民雄: 'severe' } });
t = periodAlertText(computeRiskPeriods(BASE)[0], BASE);
check(t.text.includes('大雨或強陣風'), 'the worst signal in a slot drives the wording (severe outranks rain)');

setTimeline(HOURS, { 12: { ...allTowns('rain'), 民雄: 'thunder' } });
check(periodAlertText(computeRiskPeriods(BASE)[0], BASE).text.includes('雷陣雨'), 'thunder outranks plain rain');

setTimeline(HOURS, { 12: allTowns('rain') });
check(periodAlertText(computeRiskPeriods(BASE)[0], BASE).text.includes('短暫陣雨'), 'plain rain keeps its own milder wording');

// stable/neutral 不是風險，不能產生時段
setTimeline(HOURS, { 12: allTowns('stable') });
check(computeRiskPeriods(BASE).length === 0, 'stable slots are not risky and produce no period at all');

// ── 已經過去的時段不再提醒 ─────────────────────────────────────
// 09:00 那格的風險，對 14:00 的使用者已經沒有決策價值了
setTimeline(HOURS, { 9: allTowns('thunder'), 12: allTowns('thunder') });
const afternoon = new Date(2026, 7, 27, 14, 0, 0);
const remaining = getTodayRemainingSlotTimes(afternoon);
check(remaining.every(s => s.getHours() >= 12), 'slots that have already ended are dropped');
check(computeRiskPeriods(afternoon).every(p => p.firstSlot.getHours() >= 12), 'periods never start in a slot that already ended');

// ── 時段已經開始時，不能再給早就過去的死線 ─────────────────────
// 14:30 顯示「戶外活動建議在12:00前完成」是叫人在兩個半小時前完成行程，
// 沒有任何用處，還會讓人以為畫面是舊的。已經在時段裡面的人要問的是
// 「現在能不能出去」，不是「幾點前要回來」
setTimeline(HOURS, { 12: allTowns('thunder'), 15: allTowns('thunder') });
const inside = new Date(2026, 7, 27, 14, 30, 0);
const insideText = periodAlertText(computeRiskPeriods(inside)[0], inside);
check(!insideText.advice.includes('12:00前'), 'BUG FIX: once the period has started, the advice no longer names a deadline that already passed');
check(insideText.advice.includes('目前已在風險時段內'), 'BUG FIX: it says the reader is currently inside the risky window instead');
check(insideText.advice.includes('18:00後趨緩'), 'a started period still tells the reader when it eases — that is the part still worth knowing');
check(insideText.timeLabel === '12:00～15:00', 'the time range itself is unchanged — it still accurately describes the period');

// 還沒開始的時段照舊給死線，這才是那句話真正有用的時候
const before = new Date(2026, 7, 27, 10, 0, 0);
check(periodAlertText(computeRiskPeriods(before)[0], before).advice.includes('12:00前完成'), 'a period that has not started yet still gets its 幾點前完成 deadline');

// 剛好卡在起始時間：算已經開始（12:00 整看到「建議12:00前完成」一樣沒用）
const exactly = new Date(2026, 7, 27, 12, 0, 0);
check(periodAlertText(computeRiskPeriods(exactly)[0], exactly).advice.includes('目前已在風險時段內'), 'exactly at the start time counts as started — a deadline of right now helps nobody');

// 單一格時段也要有同樣的處理
setTimeline(HOURS, { 12: allTowns('thunder') });
const singleInside = periodAlertText(computeRiskPeriods(inside)[0], inside);
check(!singleInside.advice.includes('12:00前完成戶外行程'), 'BUG FIX: single-slot periods drop the passed deadline too');
check(singleInside.advice.includes('目前已在風險時段內'), 'single-slot started period points at the current situation');
// 這裡只有 12:00 那格有風險，下一格 15:00 就轉安全，所以趨緩時間是 15:00
check(singleInside.advice.includes('15:00後趨緩'), 'single-slot started period names when it eases when that is known');

// 已開始、但後面沒有資料格 → 不能編造趨緩時間，改叫人先確認現況
setTimeline([9, 12], { 12: allTowns('thunder') });
const noRecover = periodAlertText(computeRiskPeriods(inside)[0], inside);
check(!noRecover.advice.includes('趨緩'), 'a started period with no following slot makes no 趨緩 claim');
check(noRecover.advice.includes('先確認現況'), 'instead it points the reader at the live rain-gauge card');

// ── 完全沒有風險時段 ───────────────────────────────────────────
setTimeline(HOURS, {});
renderAlertList(BASE, '今日');
check(app.elements.alertList.innerHTML.includes('暫無明顯雨勢時段'), 'a clear day says so plainly instead of rendering an empty section');
check(app.elements.alertSectionTitle.textContent === '⏰ 日間注意', 'the title stays day-agnostic (it must not say 今日 — the card flips to tomorrow after 21:00)');

// ── 端到端渲染 ─────────────────────────────────────────────────
setTimeline(HOURS, { 12: allTowns('thunder'), 15: allTowns('thunder') });
renderAlertList(BASE, '今日');
const out = app.elements.alertList.innerHTML;
check(out.includes('12:00～15:00'), 'rendered card shows the merged time range');
check(out.includes('雷陣雨機率增加'), 'rendered card shows the merged wording');
check(out.includes('18:00後趨緩'), 'rendered card shows when conditions ease');

// 資料完全沒載入時不能爆掉
setWeatherLayers({});
check(computeRiskPeriods(BASE).length === 0, 'no weather layers at all -> no periods, no throw');
renderAlertList(BASE, '今日');
check(app.elements.alertList.innerHTML.includes('暫無明顯雨勢時段'), 'no data renders the calm message rather than crashing');

check.finish();
