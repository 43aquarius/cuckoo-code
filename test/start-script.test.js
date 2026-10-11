'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// start.js 是启动编排脚本：直接 import 会触发真实编译与 Electron 启动。
// 因此本测试聚焦「源码契约 + 语法正确性」，不执行副作用。
const here = path.dirname(fileURLToPath(import.meta.url));
const startPath = path.join(here, '..', 'start.js');
const startSrc = fs.readFileSync(startPath, 'utf-8');

test('start.js 源码为合法 ES 语法结构（含 import，非空）', () => {
  assert.ok(startSrc.length > 0);
  assert.match(startSrc, /^import /m, 'start.js 应含 ESM import');
});

// —— 回归 B1：自造 mtime 层已彻底删除 ——

test('回归 B1：start.js 不含已删除的 mtime 层符号', () => {
  assert.ok(!startSrc.includes('needsCompile'), '不应含 needsCompile');
  assert.ok(!startSrc.includes('collectTsFiles'), '不应含 collectTsFiles');
  assert.ok(!startSrc.includes('toOutPath'), '不应含 toOutPath');
  assert.ok(!startSrc.includes("endsWith('.ts')"), "不应含 endsWith('.ts') 误判逻辑");
  assert.ok(!/mtimeMs/.test(startSrc), '不应残留 mtime 比较');
});

// —— 编译失败处理契约 ——

test('回归 M1：编译失败时 process.exit 非零并打印编译失败', () => {
  assert.ok(/build\.status\s*!==\s*0/.test(startSrc), '应有 build.status !== 0 判断');
  assert.ok(startSrc.includes('[start.js] 编译失败'), '应打印编译失败提示');
  assert.ok(/process\.exit\(/.test(startSrc), '应调用 process.exit');
});

// —— 日志目录与 Electron 启动契约 ——

test('start.js 日志目录指向 wyp/log 并清空旧 .log', () => {
  assert.ok(startSrc.includes("'wyp'") && startSrc.includes("'log'"), '日志目录应为 wyp/log');
  assert.ok(/endsWith\('\.log'\)/.test(startSrc), '应筛选 .log 文件清空');
  assert.ok(/electron\.log/.test(startSrc), '应写入 electron.log');
});

test('start.js 跨平台启动分支：win 用 chcp 65001 && electron', () => {
  assert.ok(startSrc.includes("process.platform === 'win32'"), '应判断 win32');
  assert.ok(startSrc.includes('chcp 65001'), 'win 分支应设 UTF-8 代码页');
  // 0.8.11 起应用路径前可插 debugArg（--remote-debugging-port），故不是字面量 'electron .'；
  // 断言改为「electron[可选参数] .」契约（args 必须在应用路径 . 之前）。
  assert.ok(/electron' \+ debugArg \+ ' \.'/.test(startSrc), '应启动 electron（可选调试参数） .');
  assert.ok(/spawn\(/.test(startSrc), '应使用 spawn 启动子进程');
});

test('start.js 子进程 stdout/stderr 管道到日志与父进程', () => {
  assert.ok(/child\.stdout\.pipe\(logStream\)/.test(startSrc), 'stdout 应 pipe 到 logStream');
  assert.ok(/child\.stderr\.pipe\(logStream\)/.test(startSrc), 'stderr 应 pipe 到 logStream');
  assert.ok(/child\.stdout\.pipe\(process\.stdout\)/.test(startSrc), 'stdout 应 pipe 到父 stdout');
});

test('start.js close/error 事件处理正确退出码', () => {
  assert.ok(/child\.on\('close'/.test(startSrc), '应有 close 处理');
  assert.ok(/child\.on\('error'/.test(startSrc), '应有 error 处理');
  assert.ok(startSrc.includes('启动失败'), 'error 应打印启动失败');
});
