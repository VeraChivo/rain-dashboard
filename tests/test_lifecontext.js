// 上課/放假模式判斷：日期規則 + 手動覆寫按鈕
const { loadApp, evaluate, createChecker, AI_REPORT_IDS } = require('./harness');

const app = loadApp({ stubIds: [...AI_REPORT_IDS, 'modeBtn'], storage: true });
const {
  getLifeContextMode, isVacationDay, VACATION_RANGES, cycleModeOverride, renderModeButton,
  setManualModeOverride, getManualModeOverride, MODE_OVERRIDE_KEY,
} = evaluate(app, `
exports.getLifeContextMode = getLifeContextMode;
exports.isVacationDay = isVacationDay;
exports.VACATION_RANGES = VACATION_RANGES;
exports.cycleModeOverride = cycleModeOverride;
exports.renderModeButton = renderModeButton;
exports.setManualModeOverride = (v) => { manualModeOverride = v; };
exports.getManualModeOverride = () => manualModeOverride;
exports.MODE_OVERRIDE_KEY = MODE_OVERRIDE_KEY;
`);

const check = createChecker();
// new Date(y, monthIndex, d) — monthIndex 是 0-based
const d = (y, mo, day) => new Date(y, mo - 1, day);

// 舊版單一寫死日期（SCHOOL_START_2026 = 2026/8/31，mode = now < that ? summer : school）
// 的三個 bug，這批測試就是它們的回歸保護：
//   1. 學期中的每個週末照樣說「接送時段」（一年約 100 天是錯的）
//   2. 寒假完全沒處理
//   3. 過了 2026/8/31 之後永遠是上課模式，包含之後每一年的暑假

// Bug 1：週末就是放假，學期中也一樣
check(getLifeContextMode(d(2026, 10, 17)) === 'holiday', 'weekend: Sat 2026-10-17 mid-term -> holiday (no school pickup on Saturdays)');
check(getLifeContextMode(d(2026, 10, 18)) === 'holiday', 'weekend: Sun 2026-10-18 mid-term -> holiday');
check(getLifeContextMode(d(2026, 10, 16)) === 'school', 'weekday: Fri 2026-10-16 mid-term -> school');
check(getLifeContextMode(d(2026, 10, 19)) === 'school', 'weekday: Mon 2026-10-19 mid-term -> school');

// Bug 2：寒假（2027-01-25 是星期一，所以走的是日期區間規則，不是週末規則）
check(d(2027, 1, 25).getDay() === 1, 'sanity: 2027-01-25 is a Monday (so the next check exercises the 寒假 range, not the weekend rule)');
check(getLifeContextMode(d(2027, 1, 25)) === 'holiday', 'winter break: Mon 2027-01-25 -> holiday');
check(getLifeContextMode(d(2027, 2, 1)) === 'holiday', 'winter break: Mon 2027-02-01 -> holiday');
check(getLifeContextMode(d(2027, 2, 22)) === 'school', 'after winter break: Mon 2027-02-22 -> school');

// Bug 3：暑假要每年重複——舊版過了那個日期就永久壞掉
check(d(2027, 7, 15).getDay() === 4, 'sanity: 2027-07-15 is a Thursday (weekday, so this exercises the 暑假 range)');
check(getLifeContextMode(d(2027, 7, 15)) === 'holiday', 'summer break repeats next year: Thu 2027-07-15 -> holiday');
check(getLifeContextMode(d(2028, 8, 10)) === 'holiday', 'summer break repeats the year after too: 2028-08-10 -> holiday');

// 暑假邊界（7/1 - 8/30 含頭含尾），刻意挑平日，免得週末規則蓋掉錯誤的區間邊界
check(d(2027, 7, 1).getDay() === 4 && isVacationDay(d(2027, 7, 1)), 'summer starts 7/1 inclusive (2027-07-01 is a Thursday)');
check(d(2026, 8, 31).getDay() === 1 && getLifeContextMode(d(2026, 8, 31)) === 'school', 'school resumes 8/31 (2026-08-31 is a Monday) — matches the old SCHOOL_START_2026 date');

check(d(2026, 8, 20).getDay() === 4, 'sanity: 2026-08-20 is a Thursday');
check(getLifeContextMode(d(2026, 8, 20)) === 'holiday', 'a Thursday inside 暑假 -> holiday, same as the old behaviour');

// 跨年區間支援：from > to 要能跨過元旦。目前沒有這種設定，但寒假哪天被
// 放寬到跨 12 月時，這個分支必須是對的
const hasWrapRange = VACATION_RANGES.some(r => (r.from[0] * 100 + r.from[1]) > (r.to[0] * 100 + r.to[1]));
check(!hasWrapRange, 'no cross-year range configured today (so the wrap branch is defensive, not load-bearing)');

// ── 手動覆寫（寒暑輔／國定假日的逃生口）─────────────────────────

check(getManualModeOverride() === 'auto', 'manualModeOverride starts as auto (no override applied yet)');
check(getLifeContextMode(d(2026, 10, 19)) === 'school', 'auto state: weekday mid-term still resolves via date logic -> school');

// 循環順序 auto -> school -> holiday -> auto，每一步都要寫進 localStorage
app.storage._reset();
cycleModeOverride();
check(getManualModeOverride() === 'school', 'cycleModeOverride: auto -> school');
check(app.storage.getItem(MODE_OVERRIDE_KEY) === 'school', 'cycleModeOverride persists "school" to localStorage');
cycleModeOverride();
check(getManualModeOverride() === 'holiday', 'cycleModeOverride: school -> holiday');
check(app.storage.getItem(MODE_OVERRIDE_KEY) === 'holiday', 'cycleModeOverride persists "holiday" to localStorage');
cycleModeOverride();
check(getManualModeOverride() === 'auto', 'cycleModeOverride: holiday -> auto (full cycle)');
check(app.storage.getItem(MODE_OVERRIDE_KEY) === 'auto', 'cycleModeOverride persists "auto" to localStorage');

// 暑輔：日期規則會說放假，但實際要上課，手動指定必須蓋得過去
setManualModeOverride('school');
check(getLifeContextMode(d(2026, 8, 20)) === 'school', 'manual "school" override forces school mode on a weekday that pure date logic would call holiday (寒暑輔 case)');

// 安全網：設了「上課」忘記切回來，也絕對不能滲到週末。這是刻意的設計，
// 讓忘記切換的代價僅限於平日
check(getLifeContextMode(d(2026, 10, 17)) === 'holiday', 'weekend safety net: manual "school" override does NOT apply on a Saturday');
check(getLifeContextMode(d(2026, 10, 18)) === 'holiday', 'weekend safety net: manual "school" override does NOT apply on a Sunday');

// 國定假日：平日但實際放假
setManualModeOverride('holiday');
check(getLifeContextMode(d(2026, 10, 19)) === 'holiday', 'manual "holiday" override forces holiday mode on an ordinary school weekday (國定假日 case)');
check(getLifeContextMode(d(2026, 10, 17)) === 'holiday', 'manual "holiday" override on a weekend is moot but still holiday (no conflict to guard against)');

// 按鈕文字：classList 是 no-op 假物件，所以只驗 textContent——那才是
// 三種狀態實際的區別
setManualModeOverride('auto');
renderModeButton();
check(app.elements.modeBtn.textContent.includes('自動'), 'renderModeButton: auto state shows 自動 in the label');

setManualModeOverride('school');
renderModeButton();
check(app.elements.modeBtn.textContent.includes('手動'), 'renderModeButton: manual "school" state shows 手動 in the label');
check(app.elements.modeBtn.textContent.includes('上課'), 'renderModeButton: manual "school" state shows 上課');

setManualModeOverride('holiday');
renderModeButton();
check(app.elements.modeBtn.textContent.includes('放假'), 'renderModeButton: manual "holiday" state shows 放假');

setManualModeOverride('auto');
check.finish();
