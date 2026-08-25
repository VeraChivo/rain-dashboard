// 共用測試底座。
//
// index.html 是單檔應用，所有邏輯在同一個 <script> 裡，沒有模組系統，
// 所以測試的做法是：把 <script> 內容整段抽出來，用 new Function 包成
// 一個假模組執行，再從尾巴附加的 exports 把要測的函式拿出來。
//
// ⚠ 關鍵陷阱：那段 script 的最底部有無條件執行的初始化呼叫
// （renderCctvGrid() / renderModeButton() / fetchAll()），載入當下就會跑。
// 所以 document.getElementById 預設一律回 null，只有明確列在 stubIds
// 裡的元素才給假物件——任何沒擋掉又會被真的操作的 DOM 元素都會讓測試
// 直接爆掉，而且錯誤訊息會指向跟你要測的東西完全無關的地方。
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');

// updateAiReport() 這條呼叫鏈碰到的元素——它取 itineraryText 之後沒有
// 立刻擋 null，而且 catch 區塊又對同一個 null 再寫一次 innerHTML，所以
// 少擋一個就會丟出「catch 裡再爆一次」的未捕捉錯誤。任何會間接呼叫
// updateAiReport 的測試都要帶上這組。
const AI_REPORT_IDS = ['itineraryText', 'rankList', 'alertList', 'rankSectionTitle', 'alertSectionTitle'];

function makeEl() {
  return { innerHTML: '', textContent: '', title: '', className: '', value: '', classList: { add() {}, remove() {}, toggle() {} } };
}

// stubIds: 要給假 DOM 元素的 id 清單（其餘一律 null）
// storage: 要不要提供可讀回的假 localStorage（Node 沒有這個全域）
function loadApp({ stubIds = [], storage = false } = {}) {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const allowed = new Set(stubIds);
  const elements = {};
  const document = {
    getElementById: (id) => {
      if (!allowed.has(id)) return null;
      if (!elements[id]) elements[id] = makeEl();
      return elements[id];
    },
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  let store = {};
  const fakeStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _reset: () => { store = {}; },
  };
  if (storage) global.localStorage = fakeStorage;

  return { script, document, elements, storage: fakeStorage, window: { addEventListener: () => {} } };
}

// exportsTail 是一段字串，附加在 script 尾巴，用來把內部函式掛到 exports。
// 需要改內部可變狀態時也在這裡加 setter（例如 setCachedShortRainLayer）。
function evaluate(app, exportsTail) {
  const m = { exports: {} };
  new Function('module', 'exports', 'document', 'window', app.script + exportsTail)(
    m, m.exports, app.document, app.window
  );
  return m.exports;
}

function createChecker() {
  const state = { allPass: true };
  function check(cond, label) {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
    state.allPass = state.allPass && !!cond;
  }
  check.finish = () => {
    console.log(state.allPass ? '\n=== ALL PASS ===' : '\n=== SOME FAILED ===');
    process.exit(state.allPass ? 0 : 1);
  };
  return check;
}

module.exports = { loadApp, evaluate, createChecker, AI_REPORT_IDS, INDEX_PATH };
