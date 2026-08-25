// ②地點排序：排序鍵是體感優先，且刻意不顯示分數
const { loadApp, evaluate, createChecker, AI_REPORT_IDS } = require('./harness');

const app = loadApp({ stubIds: [...AI_REPORT_IDS, 'modeBtn'], storage: true });
const { renderRankList } = evaluate(app, `exports.renderRankList = renderRankList;`);

const check = createChecker();

// 重現使用者 8/26 截圖的實際情況：新港/朴子 65 分但體感涼爽，溪口/北港
// 95 分但偏悶熱。體感優先的排序把 65 分那組排在 95 分前面——邏輯是對的，
// 但因為當時畫面上把分數印在旁邊，看起來就像壞掉。
const wlAdvice = {
  noData: false,
  entries: [
    { label: '新港', finalScore: 65, text: '舒適' },
    { label: '朴子', finalScore: 65, text: '舒適' },
    { label: '溪口', finalScore: 95, text: '舒適至悶熱' },
    { label: '北港', finalScore: 95, text: '舒適至悶熱' },
    { label: '斗南', finalScore: 65, text: '舒適至悶熱' },
    { label: '民雄', finalScore: 65, text: '舒適至悶熱' },
  ],
};

renderRankList(wlAdvice, [], '今日');
const out = app.elements.rankList.innerHTML;

check(!/\d+分/.test(out), '②地點排序 renders no "N分" score anywhere');
check(!out.includes('rank-score'), 'the .rank-score span is gone entirely (dead CSS class removed too)');
check(!/[🟢🟡🟠🔴⚪]/u.test(out), 'no score-derived colour emoji either — 95->🟢 vs 65->🟡 would reproduce the same contradiction');

const posXingang = out.indexOf('新港');
const posXikou = out.indexOf('溪口');
check(posXingang !== -1 && posXikou !== -1, 'both groups rendered');
check(posXingang < posXikou, 'comfort-first order preserved: the cool group still outranks the muggy group');

// 排序理由現在是唯一的說明，所以那行字一定要在
check(out.includes('天氣涼爽，體感相當舒適'), 'cool group states its reason (天氣涼爽，體感相當舒適)');
check(out.includes('天氣稍偏悶熱，體感普通'), 'muggy group states its reason (天氣稍偏悶熱，體感普通)');
check(out.includes('🥇') && out.includes('🥈'), 'medals still present so the order stays readable at a glance');

// 95 分那組不可以拿金牌——防止有人之後「順手」改成純分數排序卻沒講
const goldIdx = out.indexOf('🥇');
const silverIdx = out.indexOf('🥈');
check(goldIdx < posXingang && posXingang < silverIdx, '🥇 belongs to the 新港/朴子 (cool, 65) group, not the 95-point one');

// 全部地點條件相同時走的合併路徑
const merged = {
  noData: false,
  entries: ['新港', '朴子', '溪口', '北港', '斗南', '民雄'].map(label => ({ label, finalScore: 88, text: '舒適' })),
};
renderRankList(merged, [], '今日');
const mergedOut = app.elements.rankList.innerHTML;
check(mergedOut.includes('各地皆宜'), 'allMerged path still collapses to 各地皆宜');
check(!/\d+分/.test(mergedOut), 'allMerged path renders no score either');

// 有地點還沒拿到資料時的路徑
const partial = {
  noData: false,
  entries: [
    { label: '新港', finalScore: 70, text: '舒適' },
    { label: '北港', finalScore: null, text: '' },
  ],
};
renderRankList(partial, [], '今日');
const partialOut = app.elements.rankList.innerHTML;
check(partialOut.includes('資料尚未就緒'), 'unscored towns still say 資料尚未就緒');
check(!/\d+分/.test(partialOut), 'unscored path renders no score either');

check.finish();
