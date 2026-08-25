# 測試

```bash
node tests/run.js          # 全部跑一次
node tests/test_shortrain.js   # 只跑單一檔案
```

不需要 npm install，沒有任何相依套件，只要有 Node 就能跑。

## 這些測試在測什麼

`index.html` 是單檔應用，所有邏輯都在同一個 `<script>` 裡。測試的做法是把
那段 script 整段抽出來，用 `new Function` 包成假模組執行，再從尾巴附加的
`exports` 把要驗的函式拿出來（見 `harness.js`）。

所以這裡測的是**純邏輯**：分類規則、排序規則、文案產生、資料換算。
不打真的 API、不開瀏覽器、不驗排版。

| 檔案 | 範圍 |
| --- | --- |
| `test_lifecontext.js` | 上課/放假模式判斷、寒暑假日期區間、手動覆寫按鈕 |
| `test_rainstation.js` | O-A0002-001 雨量站選站、無效值、現況狀態推導 |
| `test_ranklist.js` | ②地點排序的體感優先規則、不顯示分數 |
| `test_shortrain.js` | F-B0046-001 四態分類、±3 格鄰近搜尋、收合徽章 |

## 寫新測試時最容易踩的坑

**那段 script 的最底部有無條件執行的初始化呼叫**（`renderCctvGrid()`、
`renderModeButton()`、`fetchAll()`），`new Function` 一執行就會跑。

所以 `harness.js` 的 `document.getElementById` **預設一律回 `null`**，只有明確
列在 `stubIds` 裡的才給假元素。少擋一個，就會在跟你要測的東西完全無關的
地方爆掉。

特別注意 `updateAiReport()` 這條鏈：它取到 `itineraryText` 之後沒有立刻擋
`null`，而且 `catch` 區塊又對同一個 `null` 再寫一次 `innerHTML`，所以會丟出
一個「在 catch 裡再爆一次」的未捕捉錯誤。任何會間接呼叫到它的測試，
`stubIds` 都要帶上 `AI_REPORT_IDS`。

需要 `localStorage` 的測試要傳 `storage: true`（Node 沒有這個全域）。

## 歷史說明：曾經遺失過一批測試

在收進 repo 之前，這些測試一直放在工作階段的暫存目錄，容器一換就沒了。
2026-08 那次就損失了 13 個檔案（涵蓋警特報、CCTV 徽章、體感、熱指數、
時段文案、UV、明日視角等），只有 4 個檔案的內容還救得回來。

**教訓：測試要跟程式碼放在同一個 repo 一起版控。** 之後新增的測試請直接
寫在這個資料夾，不要放暫存區。
