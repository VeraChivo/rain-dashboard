#!/usr/bin/env node
// 跑完 tests/ 底下所有 test_*.js，任何一個失敗就整體失敗。
// 用法：node tests/run.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => /^test_.*\.js$/.test(f)).sort();
let failed = [];

for (const f of files) {
  process.stdout.write(`\n─── ${f} ${'─'.repeat(Math.max(0, 50 - f.length))}\n`);
  try {
    process.stdout.write(execFileSync('node', [path.join(__dirname, f)], { encoding: 'utf8' }));
  } catch (e) {
    process.stdout.write((e.stdout || '') + (e.stderr || ''));
    failed.push(f);
  }
}

console.log(`\n${'='.repeat(56)}`);
if (failed.length) {
  console.log(`✗ ${failed.length}/${files.length} 個檔案失敗: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`✓ ${files.length} 個測試檔案全部通過`);
