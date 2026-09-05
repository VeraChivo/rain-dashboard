// 👕 曬衣建議：整段窗口的最壞情況、幾點收、地點記憶
//
// 曬衣服跟出門是不同的問題：出門可以挑時段閃過雨，衣服掛在那裡不會閃，
// 窗口內任何一格下雨就濕了。所以斷言重點在「有沒有漏掉窗口裡的雨」
const { loadApp, evaluate, createChecker, AI_REPORT_IDS } = require('./harness');

const app = loadApp({
  stubIds: [...AI_REPORT_IDS, 'modeBtn', 'laundryTownSelect', 'laundrySummaryBadge', 'laundryDetail'],
  storage: true,
});
const {
  buildLaundryAdvice, laundryWindowSlots, isBadForLaundry, laundrySummaryBadge,
  renderLaundryCard, setLaundryTown, laundryDefaultTown, getLaundryTown,
  setWeatherLayers, LAUNDRY_TOWN_KEY, LAUNDRY_POP_LIMIT, DIRECTION_WEIGHTS,
  laundryScopeTowns, LAUNDRY_NEARBY_KM, setCctvStates,
} = evaluate(app, `
exports.buildLaundryAdvice = buildLaundryAdvice;
exports.laundryWindowSlots = laundryWindowSlots;
exports.isBadForLaundry = isBadForLaundry;
exports.laundrySummaryBadge = laundrySummaryBadge;
exports.renderLaundryCard = renderLaundryCard;
exports.setLaundryTown = setLaundryTown;
exports.laundryDefaultTown = laundryDefaultTown;
exports.getLaundryTown = () => laundryTown;
exports.LAUNDRY_TOWN_KEY = LAUNDRY_TOWN_KEY;
exports.LAUNDRY_POP_LIMIT = LAUNDRY_POP_LIMIT;
exports.DIRECTION_WEIGHTS = DIRECTION_WEIGHTS;
exports.laundryScopeTowns = laundryScopeTowns;
exports.LAUNDRY_NEARBY_KM = LAUNDRY_NEARBY_KM;
exports.setWeatherLayers = (v) => { cachedWeatherLayers = v; };
exports.setCctvStates = (v) => { cctvStates = v; };
`);

const check = createChecker();

const at = (h, day = 27) => new Date(2026, 7, day, h, 0, 0);
const MORNING = new Date(2026, 7, 27, 7, 0, 0); // 早上七點，整個曬衣窗口都還在前面

// slots: [{h, pop, signal, text, rh}]，day 用來鋪明天的資料
function setDay(slots, day = 27) {
  const layers = {};
  for (const label of Object.keys(DIRECTION_WEIGHTS)) {
    layers[label] = {
      risk: slots.map(s => ({
        start: at(s.h, day), end: at(s.h + 3, day),
        pop: s.pop, text: s.text || '多雲', signalLevel: s.signal || 'stable',
      })),
      raw: { RH: { time: slots.map(s => ({ start: at(s.h, day), raw: { RH: String(s.rh ?? 78) } })) } },
    };
  }
  setWeatherLayers(layers);
  return layers;
}
// 併兩天的資料（測「今天曬不成改看明天」）
function setTwoDays(todaySlots, tomorrowSlots) {
  const a = setDay(todaySlots, 27);
  const b = setDay(tomorrowSlots, 28);
  const merged = {};
  for (const label of Object.keys(DIRECTION_WEIGHTS)) {
    merged[label] = {
      risk: [...a[label].risk, ...b[label].risk],
      raw: { RH: { time: [...a[label].raw.RH.time, ...b[label].raw.RH.time] } },
    };
  }
  setWeatherLayers(merged);
}

const HOME = laundryDefaultTown();

// ── 預設地點 ───────────────────────────────────────────────────
// 衣服曬在家裡，不是六個方向都曬，所以要挑一個地點而不是取全區最壞——
// 取全區最壞會讓 20 公里外的雷陣雨蓋掉自家的好天氣，天天說不能曬
check(DIRECTION_WEIGHTS[HOME] === Math.max(...Object.values(DIRECTION_WEIGHTS)), 'default laundry town is the highest life-circle weight, not an arbitrary first key');
check(getLaundryTown() === HOME, 'the module starts on that default');

// ── 全天沒雨 ───────────────────────────────────────────────────
setDay([
  { h: 6, pop: 10 }, { h: 9, pop: 10 }, { h: 12, pop: 20 }, { h: 15, pop: 20 },
]);
let a = buildLaundryAdvice(HOME, MORNING);
check(a.status === 'good', 'a clear window -> good');
check(a.headline === '今天可以曬', 'good headline names the day and gives a straight yes');
check(laundrySummaryBadge(a).cls === 'calm', 'good state renders as a calm badge');

// ── 下午開始有雨：要講幾點收 ───────────────────────────────────
setDay([
  { h: 6, pop: 10 }, { h: 9, pop: 20 },
  { h: 12, pop: 70, signal: 'thunder', text: '午後雷陣雨' }, { h: 15, pop: 60, signal: 'thunder' },
]);
a = buildLaundryAdvice(HOME, MORNING);
check(a.status === 'caution', 'rain later in the window -> caution, not a flat no');
check(a.headline === '可以曬，12:00 前收', 'caution headline names the exact time to bring it in');
check(laundrySummaryBadge(a).cls === 'alert', 'caution renders as an alert badge');

// 收衣服時間要抓「第一個」有雨的格，不是最後一個或最嚴重的那格
setDay([
  { h: 6, pop: 10 }, { h: 9, pop: 50 }, { h: 12, pop: 20 }, { h: 15, pop: 95, signal: 'severe' },
]);
check(buildLaundryAdvice(HOME, MORNING).headline === '可以曬，09:00 前收', 'the take-in time is the FIRST risky slot — a later, worse slot must not push it back');

// ── 現在就在下、但晚點會轉好 ───────────────────────────────────
// 講「今天不能曬」是錯的，也沒用；該講的是幾點之後可以
setDay([
  { h: 6, pop: 80, signal: 'rain' }, { h: 9, pop: 80, signal: 'rain' },
  { h: 12, pop: 10 }, { h: 15, pop: 10 },
]);
a = buildLaundryAdvice(HOME, MORNING);
check(a.status === 'later', 'raining now but clearing later -> later, not bad');
check(a.headline === '先別曬，12:00 後再看', 'later headline names when it becomes worth hanging');

// ── 整段窗口都有雨 ─────────────────────────────────────────────
setDay([
  { h: 6, pop: 80, signal: 'rain' }, { h: 9, pop: 90, signal: 'thunder' },
  { h: 12, pop: 80, signal: 'thunder' }, { h: 15, pop: 70, signal: 'rain' },
]);
a = buildLaundryAdvice(HOME, MORNING);
check(a.status === 'bad', 'rain across the whole window -> bad');
check(a.headline === '今天不適合曬', 'bad headline says so plainly');
check(a.reasons.some(r => r.includes('都有降雨機率')), 'bad state explains it covers the whole window');
check(!a.reasons.some(r => r.includes('乾得快') || r.includes('日照')), 'drying-speed notes are omitted once the answer is no — they would just be noise');

// ── pop 門檻 ───────────────────────────────────────────────────
// 天氣描述說「多雲」但降雨機率 40%，衣服還是會濕。40 是對照表色階
// 本來就有的界線，不是這裡新發明的
check(LAUNDRY_POP_LIMIT === 40, 'the pop limit reuses the existing 40% colour-band boundary');
check(isBadForLaundry({ pop: 40, signalLevel: 'stable' }) === true, 'pop exactly at the limit counts as unsafe');
check(isBadForLaundry({ pop: 39, signalLevel: 'stable' }) === false, 'pop just under the limit is fine');
check(isBadForLaundry({ pop: 10, signalLevel: 'thunder' }) === true, 'a risky weather signal counts even when pop is low');
check(isBadForLaundry({ pop: null, signalLevel: 'stable' }) === false, 'a missing pop alone does not condemn a slot');

// ── 曬衣窗口的時間界線 ─────────────────────────────────────────
// 天亮前掛出去沒意義，天黑後不會再乾還會回潮，所以窗口是 06:00-18:00
setDay([
  { h: 3, pop: 90, signal: 'rain' }, { h: 9, pop: 10 },
  { h: 18, pop: 90, signal: 'rain' }, { h: 21, pop: 90, signal: 'rain' },
]);
const w = laundryWindowSlots(HOME, MORNING);
check(w.slots.every(s => s.start.getHours() >= 6 && s.start.getHours() < 18), 'the window only covers 06:00-18:00');
check(buildLaundryAdvice(HOME, MORNING).status === 'good', 'rain before dawn and after dark does not block hanging laundry during the day');

// 已經過去的時段不算——中午才問的人不需要知道早上八點的雨
setDay([
  { h: 6, pop: 90, signal: 'rain' }, { h: 9, pop: 90, signal: 'rain' },
  { h: 12, pop: 10 }, { h: 15, pop: 10 },
]);
const noon = new Date(2026, 7, 27, 12, 30, 0);
check(laundryWindowSlots(HOME, noon).slots.every(s => s.end > noon), 'slots that already ended are dropped from the window');
check(buildLaundryAdvice(HOME, noon).status === 'good', 'this morning rain does not veto hanging laundry this afternoon');

// ── 今天曬不成就看明天 ─────────────────────────────────────────
// 傍晚問的人真正想知道的是「明天早上行不行」，回「今天不行」沒有用
setTwoDays(
  [{ h: 6, pop: 10 }, { h: 9, pop: 10 }, { h: 12, pop: 10 }, { h: 15, pop: 10 }],
  [{ h: 6, pop: 10 }, { h: 9, pop: 10 }, { h: 12, pop: 80, signal: 'thunder' }, { h: 15, pop: 80, signal: 'thunder' }]
);
const evening = new Date(2026, 7, 27, 19, 0, 0);
a = buildLaundryAdvice(HOME, evening);
check(a.day === 'tomorrow', 'after the window closes, the card rolls over to tomorrow instead of saying nothing useful');
check(a.headline === '可以曬，12:00 前收', 'tomorrow is evaluated on its own slots');

// ── 濕度與日照只影響「多快乾」，不影響能不能曬 ─────────────────
setDay([{ h: 6, pop: 10, rh: 92 }, { h: 9, pop: 10, rh: 92 }, { h: 12, pop: 10, rh: 92 }]);
a = buildLaundryAdvice(HOME, MORNING);
check(a.status === 'good', 'high humidity alone never blocks hanging laundry — rain decides that');
check(a.reasons.some(r => r.includes('不容易乾')), 'but high humidity is reported so the reader knows it will be slow');
check(a.humidity === 92, 'humidity is averaged from the RH element and surfaced');

setDay([{ h: 6, pop: 10, rh: 62 }, { h: 9, pop: 10, rh: 62 }, { h: 12, pop: 10, rh: 62 }]);
check(buildLaundryAdvice(HOME, MORNING).reasons.some(r => r.includes('乾得快')), 'low humidity is reported as fast drying');

setDay([{ h: 6, pop: 10, rh: 78 }, { h: 9, pop: 10, rh: 78 }]);
check(!buildLaundryAdvice(HOME, MORNING).reasons.some(r => r.includes('濕度')), 'ordinary humidity says nothing at all — no noise on a normal day');

setDay([{ h: 6, pop: 10, text: '晴' }, { h: 9, pop: 10, text: '晴' }, { h: 12, pop: 10, text: '晴' }]);
check(buildLaundryAdvice(HOME, MORNING).reasons.includes('日照充足'), 'a sunny window is reported as good drying');

setDay([{ h: 6, pop: 10, text: '陰天' }, { h: 9, pop: 10, text: '陰天' }, { h: 12, pop: 10, text: '陰天' }]);
check(buildLaundryAdvice(HOME, MORNING).reasons.includes('整天偏陰，乾得慢'), 'an overcast window is reported as slow drying');

// ── 地點切換與記憶 ─────────────────────────────────────────────
app.storage._reset();
setLaundryTown('斗南');
check(getLaundryTown() === '斗南', 'setLaundryTown switches the town');
check(app.storage.getItem(LAUNDRY_TOWN_KEY) === '斗南', 'the chosen town is persisted so it survives a reload');
setLaundryTown('不存在的地方');
check(getLaundryTown() === '斗南', 'an unknown town is rejected rather than breaking the card');
setLaundryTown(HOME);

// ── 鄰鎮下雨也算（使用者實測回報：新港預報沒事，民雄在暴雨）───────
// 對流胞 5~20 公里大、時速 20~40 公里，民雄離新港 6.8 公里，那場雨
// 半小時內就到自家院子。只看自己那一格會整個漏掉
setCctvStates({});
const scope = laundryScopeTowns('新港').map(t => t.label);
check(scope[0] === '新港', 'the chosen town leads its own scope');
check(scope.includes('民雄') && scope.includes('溪口') && scope.includes('北港'),
  '新港 scope covers 溪口 4.3km / 民雄 6.8km / 北港 7.0km — close enough for a cell to drift over');
check(!scope.includes('斗南'), '斗南 at 19.3km is outside the radius — a storm that far away must not veto a fine day at home');
check(!scope.includes('朴子'), '朴子 at 15.3km is outside the radius too');
check(LAUNDRY_NEARBY_KM === 15, 'the radius is 15km, sitting between 北港 7.0km and 朴子 15.3km');

// 每個地點都要有鄰居可參考，包括最偏遠的斗南（最近的溪口 15.1km 剛好卡在半徑外）
check(laundryScopeTowns('斗南').length >= 2, 'even the most isolated town gets its nearest neighbour — some reference beats none');
check(laundryScopeTowns('斗南')[1].label === '溪口', '斗南 falls back to 溪口, its nearest at 15.1km');

// 自家一片晴朗、民雄下午雷陣雨 → 還是要收
function setPerTown(perTown, day = 27) {
  const layers = {};
  for (const [label, slots] of Object.entries(perTown)) {
    layers[label] = {
      risk: slots.map(s => ({
        start: at(s.h, day), end: at(s.h + 3, day),
        pop: s.pop, text: s.text || '多雲', signalLevel: s.signal || 'stable',
      })),
      raw: { RH: { time: slots.map(s => ({ start: at(s.h, day), raw: { RH: String(s.rh ?? 78) } })) } },
    };
  }
  setWeatherLayers(layers);
}
const clear = [{ h: 6, pop: 10 }, { h: 9, pop: 10 }, { h: 12, pop: 10 }, { h: 15, pop: 10 }];
const stormyPM = [{ h: 6, pop: 10 }, { h: 9, pop: 10 }, { h: 12, pop: 90, signal: 'thunder' }, { h: 15, pop: 90, signal: 'thunder' }];

setPerTown({ 新港: clear, 溪口: clear, 民雄: stormyPM, 北港: clear, 朴子: clear, 斗南: clear });
a = buildLaundryAdvice('新港', MORNING);
check(a.status === 'caution', 'BUG FIX: 民雄 storming in the afternoon makes 新港 laundry a caution, even though 新港 own forecast is clear');
check(a.headline === '可以曬，12:00 前收', 'BUG FIX: the neighbour sets the take-in time');
check(a.reasons.some(r => r.includes('民雄') && r.includes('公里外')),
  'BUG FIX: the card names the neighbour and its distance — otherwise a clear home forecast with a red row looks like a bug');
check(a.reasons.some(r => r.includes('6.8公里外')), 'the real distance is shown, not a vague 附近');

// 反過來：斗南（19.3km）暴雨不能否決新港的好天氣
setPerTown({ 新港: clear, 溪口: clear, 民雄: clear, 北港: clear, 朴子: clear, 斗南: stormyPM });
check(buildLaundryAdvice('新港', MORNING).status === 'good', 'a storm at 斗南 19.3km away does NOT veto hanging laundry at 新港');

// 自家自己就有雨時，不用特別說是誰造成的——看時段表就知道
setPerTown({ 新港: stormyPM, 溪口: clear, 民雄: clear, 北港: clear, 朴子: clear, 斗南: clear });
a = buildLaundryAdvice('新港', MORNING);
check(a.status === 'caution' && a.headline === '可以曬，12:00 前收', 'the home town own rain still drives the deadline');
check(!a.reasons.some(r => r.includes('會飄過來')), 'when it is the home town own rain, no neighbour attribution is added');

// ── 現況：隔壁正在下雨 ─────────────────────────────────────────
// 衣服已經掛在外面了，這比任何預報都急
setPerTown({ 新港: clear, 溪口: clear, 民雄: clear, 北港: clear, 朴子: clear, 斗南: clear });
setCctvStates({ 民雄: 'raining' });
a = buildLaundryAdvice('新港', MORNING);
check(a.status === 'urgent', 'a neighbouring gauge actually raining right now -> urgent, overriding a clear forecast');
check(a.headline === '民雄 正在下雨，先去收', 'urgent headline names the town that is raining');
check(a.reasons[0].includes('雨量站') && a.reasons[0].includes('6.8公里外'), 'the live reason leads, and cites the gauge and distance');
check(laundrySummaryBadge(a).cls === 'alert', 'urgent renders as an alert badge');

setCctvStates({ 新港: 'raining' });
check(buildLaundryAdvice('新港', MORNING).headline === '正在下雨，快去收', 'rain at home itself gets the most direct wording');

// 只是「近期下過」不夠急，不要把 wet 當成正在下
setCctvStates({ 民雄: 'wet' });
check(buildLaundryAdvice('新港', MORNING).status === 'good', 'a merely wet (recently rained) gauge does not trigger the urgent state');

// 太遠的地方正在下雨也不算
setCctvStates({ 斗南: 'raining' });
check(buildLaundryAdvice('新港', MORNING).status === 'good', 'a gauge raining 19.3km away is out of scope and does not raise an alarm');
setCctvStates({});

// ── 沒資料 ─────────────────────────────────────────────────────
setWeatherLayers({});
a = buildLaundryAdvice(HOME, MORNING);
check(a.status === 'nodata', 'no weather layers -> nodata, no throw');
check(laundrySummaryBadge(a) === null, 'nodata shows no badge rather than a misleading one');

// ── 端到端渲染 ─────────────────────────────────────────────────
setDay([{ h: 6, pop: 10 }, { h: 9, pop: 20 }, { h: 12, pop: 70, signal: 'thunder' }]);
renderLaundryCard(MORNING);
const out = app.elements.laundryDetail.innerHTML;
check(out.includes('可以曬，12:00 前收'), 'rendered card leads with the headline');
check(app.elements.laundrySummaryBadge.textContent === '（可以曬，12:00 前收）', 'collapsed badge answers the question without opening the card');
check(out.includes('06:00') && out.includes('12:00'), 'every slot in the window is listed so the conclusion can be checked');
check(out.includes('70%'), 'each slot shows its rain probability');
check(out.includes('is-bad'), 'the slot that forces the take-in time is marked');
check(app.elements.laundryTownSelect.innerHTML.includes(`value="${HOME}" selected`), 'the town selector reflects the current town');

setWeatherLayers({});
renderLaundryCard(MORNING);
check(app.elements.laundryDetail.innerHTML.includes('尚未就緒'), 'no data renders a plain message instead of crashing');

check.finish();
