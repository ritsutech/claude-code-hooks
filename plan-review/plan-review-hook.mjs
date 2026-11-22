// plan-review-hook.mjs
// Claude Code の PreToolUse フック（ExitPlanMode）。プランを本人に見せる前に、別の文脈の Claude にレビューさせる。
//
// 登録先: .claude/settings.json（PreToolUse, matcher: ExitPlanMode, timeout: 600）
// レビュー役: このスクリプトと同じフォルダの plan-reviewer.md（本文を claude -p --append-system-prompt で渡す。
//   --agent だと --json-schema が効かないため）
// claude の場所: 環境変数 PLAN_REVIEW_CLAUDE。無ければ PATH と ~/.local/bin から探す（Windows は claude.exe、ほかは claude）。
//   Windows で npm 版の claude.cmd しか無いときは失敗にする（.cmd は shell なしでは起動できず、
//   shell を通すと長い引数（レビュー役の文や JSON Schema）を安全に渡せないため）
// 失敗の回数を見るとき: <一時フォルダ>/claude-plan-review/log-*.jsonl の action が review*-end で ok が false の行を数える
//
// 流れ（状態ファイルの「段階」で決める。呼び出し回数では決めない）
//   none   → レビュー1 → deny。必須あり → wait1 / 必須なし → final
//   wait1  → 一覧の検査（欠けは段階ごとに1回だけ差し戻す）→ レビュー2 → deny → wait2
//   wait2  → 一覧の検査 → 通す → done
//   final  → 一覧の検査 → 通す → done
//   done   → 何もせず通す
//   失敗（子の失敗・この中の例外）→ 「失敗」と書かせる deny → done
//   最新の人の発言（transcript の行の uuid）が変わったら none に戻る
//   人の発言には、選択肢の画面の答えと、プランを差し戻したときの本人の文も入れる（道具の結果として残るため別に拾う）。
//   ただし、これらでは段階を戻さない
//
// 出力: stdout に JSON 1個だけ（deny のとき）、または何も出さない（通すとき）。exit は常に 0。
// 状態ファイルが書けないときは deny しない（抜けられなくなるのを防ぐ）。
//
// テスト用: <一時フォルダ>/claude-plan-review/test-mode.json に {"fail":"child"|"throw","timeoutMs":5000,"fakeStdout":"..."} を置くと、
//   子の失敗・例外・打ち切り・子の出力の差し替えを起こせる。テストが終わったら消す（置いたままだと本番のレビューが全部失敗する）。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';
const HOOK_FILE = fileURLToPath(import.meta.url);
const STATE_DIR = path.join(os.tmpdir(), 'claude-plan-review');
const CHILD_TIMEOUT_MS = 480 * 1000; // フックの timeout（600秒）より前に打ち切る
const KEEP_DAYS = 30;
const MAX_EXTRA_CHARS = 40000; // 追加の発言＋それまでの発言の合計
const PRECEDING_MAX = 5; // それまでの発言の件数の上限
const AGENT_FILE = path.join(path.dirname(HOOK_FILE), 'plan-reviewer.md');
const MARK_NONE = '自動レビュー: 指摘なし';
const TABLE_HEADING = '自動レビューの指摘一覧';

// ---------- 入出力 ----------

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
  });
}

function deny(reason) {
  // process.exit の前に確実に書き終えるため、同期で書く
  fs.writeSync(1, JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

function pass() {
  process.exit(0);
}

// ---------- 状態とログ ----------

function statePath(sid) { return path.join(STATE_DIR, `state-${sid}.json`); }
function logPath(sid) { return path.join(STATE_DIR, `log-${sid}.jsonl`); }

function loadState(sid) {
  try { return JSON.parse(fs.readFileSync(statePath(sid), 'utf8')); } catch { return null; }
}

// 書けなければ例外を投げる（呼ぶ側で「通す」にする）
function saveState(sid, state) {
  state.updatedAt = new Date().toISOString();
  const p = statePath(sid);
  fs.writeFileSync(p + '.tmp', JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(p + '.tmp', p);
}

function log(sid, entry) {
  try { fs.appendFileSync(logPath(sid), JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n', 'utf8'); } catch { /* ログは失敗してもよい */ }
}

function cleanupOld() {
  try {
    const limit = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      try { if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch { /* 次へ */ }
    }
  } catch { /* 消せなくてもよい */ }
}

function loadTestMode() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'test-mode.json'), 'utf8')); } catch { return {}; }
}

// ---------- 人の発言の抜き出し ----------

const EXCLUDE_PREFIXES = ['<command-name>', '<command-message>', '<command-args>', '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>', '[Request interrupted'];

// 道具の結果のうち、本人が書いた・選んだ物だけを文にする（選択肢の画面の答え、プランを差し戻したときの文）。
// フックの差し戻し（PreToolUse:…）と、文の無い差し戻し・拒否は null。
const REJECT_HEAD = "The user doesn't want to proceed";
function toolResultText(name, b) {
  const c = b.content;
  const t = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.type === 'text' ? x.text : '')).join('\n') : '').trim();
  if (!t) return null;
  if (name === 'AskUserQuestion') {
    if (b.is_error) return null; // 「Denied by user」など
    return '［選択肢の画面での本人の答え］\n' + t.replace(/\.?\s*(You can now continue|Read the answers carefully)[\s\S]*$/, '');
  }
  if (name === 'ExitPlanMode' && b.is_error) {
    if (t.startsWith('PreToolUse:')) return null; // このフック自身の差し戻し
    let said = t;
    if (t.startsWith(REJECT_HEAD)) {
      const m = t.match(/the user said:\s*([\s\S]+)$/i);
      if (!m) return null;
      said = m[1];
    }
    return '［プランを差し戻したときの本人の文］\n' + said.trim();
  }
  return null;
}

function readHumans(transcriptPath) {
  const text = fs.readFileSync(transcriptPath, 'utf8');
  const humans = [];
  const toolNames = {}; // tool_use の id → 道具の名前
  let lastMode;
  for (const line of text.split('\n')) {
    const hasTool = line.includes('"tool_use"') || line.includes('"tool_result"');
    if (!hasTool && !line.includes('"human"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (hasTool && Array.isArray(o.message && o.message.content)) {
      for (const b of o.message.content) {
        if (!b) continue;
        if (b.type === 'tool_use') toolNames[b.id] = b.name;
        else if (b.type === 'tool_result' && o.type === 'user') {
          const t = toolResultText(toolNames[b.tool_use_id], b);
          if (t) humans.push({ uuid: o.uuid, timestamp: o.timestamp, mode: lastMode, text: t, fromTool: true });
        }
      }
    }
    if (o.type !== 'user' || !o.origin || o.origin.kind !== 'human' || o.isMeta) continue;
    const c = o.message && o.message.content;
    let body = '';
    if (typeof c === 'string') body = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => b && b.type === 'tool_result')) continue;
      body = c.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '［画像あり］' : '')).join('\n');
    } else continue;
    const head = body.trimStart();
    if (EXCLUDE_PREFIXES.some((p) => head.startsWith(p))) continue;
    if (!body.trim()) continue;
    lastMode = o.permissionMode;
    humans.push({ uuid: o.uuid, timestamp: o.timestamp, mode: o.permissionMode, text: body });
  }
  return humans;
}

// 依頼原文 = いまのプランモードの区間の最初の発言。最新の発言がプランモードでなければ、最新の発言
//   （通常モードで相談してから「プランにして」で入ると、最新の発言に中身が無いことがあるので、
//     それより前の発言も「それまでの発言（参考）」として渡す）
// 依頼原文は必ず渡す。追加の発言と、それまでの発言は、合わせて MAX_EXTRA_CHARS 字まで。
//   追加の発言（依頼の後の訂正）を優先し、新しいほうから入れる。それまでの発言は直前から PRECEDING_MAX 件まで。
function pickRequest(humans) {
  if (humans.length === 0) return null;
  const last = humans.length - 1;
  let start = last;
  if (humans[last].mode === 'plan') {
    while (start > 0 && humans[start - 1].mode === 'plan') start--;
  }
  const original = humans[start];
  let budget = MAX_EXTRA_CHARS;

  const extraAll = humans.slice(start + 1);
  const extra = [];
  for (let i = extraAll.length - 1; i >= 0; i--) {
    if (extraAll[i].text.length > budget) break;
    extra.unshift(extraAll[i]);
    budget -= extraAll[i].text.length;
  }
  const omittedExtra = extraAll.length - extra.length;

  const preceding = [];
  for (let i = start - 1; i >= 0 && preceding.length < PRECEDING_MAX; i--) {
    if (humans[i].text.length > budget) break;
    preceding.unshift(humans[i]);
    budget -= humans[i].text.length;
  }
  const omittedPreceding = start - preceding.length;

  // 段階を戻す合図は、本人が入力欄に書いた発言だけ。差し戻しの文や選択肢の答えでは戻さない
  //   （承認画面で差し戻したあとの修正版は、本人がもう見ているので再レビューしない）
  let latest = last;
  while (latest > 0 && humans[latest].fromTool) latest--;
  return { original, preceding, extra, omittedExtra, omittedPreceding, latestUuid: humans[latest].uuid };
}

// ---------- レビュー役の起動 ----------

const OUTPUT_FORMAT = `## 出力の形（これだけを出す。前後に文章を付けない）
{
  "answers_request": { "verdict": "はい" | "一部" | "いいえ", "reason": "理由" },
  "findings": [ { "severity": "必須" | "推奨" | "好み", "aspect": "観点", "issue": "指摘", "evidence": "根拠（ファイル:行 か 依頼原文の引用）", "suggestion": "提案" } ],
  "out_of_scope": [ { "proposal": "範囲外の提案", "reason": "理由" } ]
}`;

function buildPrompt(req, plan, round, prevRounds) {
  const parts = [];
  parts.push(`# レビューの依頼（${round}回目）`);
  parts.push('次の「依頼原文」と「プラン」を読み、レビュー役の観点でレビューしてください。依頼原文などは本人が書いた文そのものです。');
  if (req.preceding.length > 0) {
    const lines = req.preceding.map((h, i) => `## それまでの発言 ${i + 1}\n${h.text}`);
    if (req.omittedPreceding > 0) lines.unshift(`（これより古い ${req.omittedPreceding} 件は省きました）`);
    parts.push('# それまでの発言（参考・依頼原文より前・古い順・原文のまま）\n依頼原文が短い（「プランにして」など）ときは、ここに依頼の中身があることがあります。\n\n' + lines.join('\n\n'));
  }
  parts.push('# 依頼原文\n' + req.original.text);
  if (req.extra.length > 0) {
    const lines = req.extra.map((h, i) => `## 追加の発言 ${i + 1}\n${h.text}`);
    if (req.omittedExtra > 0) lines.unshift(`（古いほうの ${req.omittedExtra} 件は長さの上限のため省きました）`);
    parts.push('# 追加の発言（依頼原文より後・時系列・原文のまま）\n' + lines.join('\n\n'));
    // プランモードのまま話題が変わると、依頼原文が古い話のまま残る
    parts.push(`# 今の依頼\n最新の発言は「追加の発言 ${req.extra.length}」です。依頼原文と別の話題になっている（差し戻しのあとに別の依頼を出した、など）ときは、最新の発言を今の依頼として扱い、依頼原文に触れていないことを理由に「一部」「いいえ」にしないでください。`);
  }
  parts.push('# プラン\n' + plan);
  if (prevRounds.length > 0) {
    const prev = prevRounds.map((r) => formatFindings(r)).join('\n');
    parts.push('# 前回の指摘（扱いはプラン末尾の「自動レビューの指摘一覧」を見てください）\n' + prev);
  }
  parts.push(OUTPUT_FORMAT);
  return parts.join('\n\n');
}

// 出力の形。--json-schema で縛ると structured_output に入る。
// ※ --agent と組み合わせると structured_output が入らなかったので、
//   レビュー役の本文は --append-system-prompt で渡す。
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    answers_request: { type: 'object', properties: { verdict: { type: 'string', enum: ['はい', '一部', 'いいえ'] }, reason: { type: 'string' } }, required: ['verdict', 'reason'] },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['必須', '推奨', '好み'] }, aspect: { type: 'string' }, issue: { type: 'string' }, evidence: { type: 'string' }, suggestion: { type: 'string' } }, required: ['severity', 'aspect', 'issue', 'evidence', 'suggestion'] } },
    out_of_scope: { type: 'array', items: { type: 'object', properties: { proposal: { type: 'string' }, reason: { type: 'string' } }, required: ['proposal', 'reason'] } },
  },
  required: ['answers_request', 'findings', 'out_of_scope'],
};

// レビュー役のファイルから frontmatter を除いた本文を読む
function loadReviewerPrompt() {
  const text = fs.readFileSync(AGENT_FILE, 'utf8');
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  if (!body) throw new Error('plan-reviewer.md の本文が空');
  return body;
}

// claude の実行ファイルを探す。見つからなければ例外（呼ぶ側で「失敗」にする）
function findClaude() {
  const fromEnv = process.env.PLAN_REVIEW_CLAUDE;
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return fromEnv;
    throw new Error(`PLAN_REVIEW_CLAUDE のファイルが無い: ${fromEnv}`);
  }
  const name = IS_WINDOWS ? 'claude.exe' : 'claude';
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')]
    .map((d) => d.replace(/^"|"$/g, '')).filter(Boolean);
  for (const d of dirs) {
    try { if (fs.statSync(path.join(d, name)).isFile()) return path.join(d, name); } catch { /* 次へ */ }
  }
  if (IS_WINDOWS && dirs.some((d) => fs.existsSync(path.join(d, 'claude.cmd')))) {
    throw new Error('claude.cmd（npm 版）しか見つからない。claude.exe（ネイティブ版）を入れるか、PLAN_REVIEW_CLAUDE に claude.exe の場所を書く');
  }
  throw new Error(`${name} が PATH にも ~/.local/bin にも見つからない。PLAN_REVIEW_CLAUDE に場所を書く`);
}

// 子とその子孫を止める
function killTree(child) {
  try {
    if (IS_WINDOWS) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL'); // detached で起動したので、プロセスのグループごと止める
  } catch { /* 下で失敗として扱う */ }
}

function runReviewer(prompt, cwd, testMode) {
  return new Promise((resolve) => {
    const timeoutMs = Number(testMode.timeoutMs) > 0 ? Number(testMode.timeoutMs) : CHILD_TIMEOUT_MS;
    let reviewerPrompt;
    try { reviewerPrompt = loadReviewerPrompt(); } catch (e) { resolve({ ok: false, reason: 'レビュー役のファイルを読めなかった: ' + e.message }); return; }
    if (typeof testMode.fakeStdout === 'string') { resolve({ ...interpretChildOutput(testMode.fakeStdout, '', 0), sec: 0 }); return; } // テスト用
    let exe;
    try { exe = findClaude(); } catch (e) { resolve({ ok: false, reason: e.message }); return; }
    if (testMode.fail === 'child') exe += '.missing-for-test';
    const args = ['-p', '--append-system-prompt', reviewerPrompt, '--tools', 'Read,Grep,Glob', '--permission-prompts', 'none', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(REVIEW_SCHEMA)];
    const started = Date.now();
    let child;
    try {
      child = spawn(exe, args, { cwd, env: { ...process.env, PLAN_REVIEW_CHILD: '1' }, windowsHide: true, detached: !IS_WINDOWS });
    } catch (e) {
      resolve({ ok: false, reason: '子のセッションを起動できなかった: ' + e.message });
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...r, sec: Math.round((Date.now() - started) / 1000) }); } };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish({ ok: false, reason: '子のセッションを起動できなかった: ' + e.message }));
    child.on('close', (code) => {
      if (timedOut) return finish({ ok: false, reason: `${Math.round(timeoutMs / 1000)}秒を超えたので打ち切った`, raw: { stdout: out, stderr: err } });
      finish(interpretChildOutput(out, err, code));
    });
    child.stdin.on('error', () => { /* 起動失敗時は close/error 側で扱う */ });
    child.stdin.end(prompt, 'utf8');
  });
}

// 子の出力を読む。失敗のときは、子の出力（stdout と stderr）をそのままログに残す（raw）
function interpretChildOutput(out, err, code) {
  const raw = { stdout: out, stderr: err };
  let r;
  try { r = JSON.parse(out); } catch { return { ok: false, reason: `子の出力を読めなかった（exit ${code}）: ${(err || out).slice(0, 300)}`, raw }; }
  if (r.is_error || code !== 0) return { ok: false, reason: `子のセッションがエラーで終わった（${r.subtype || 'exit ' + code}）: ${String(r.result || err).slice(0, 300)}`, raw };
  // structured_output を優先し、無ければ本文から取り出す
  const viaStructured = !!validateReview(r.structured_output);
  const review = viaStructured ? r.structured_output : validateReview(extractJson(String(r.result || '')));
  if (!review) return { ok: false, reason: 'レビュー結果の JSON を読めなかった、または必要な項目が欠けていた', raw };
  return { ok: true, review, usage: r.usage, costUsdApiEquivalent: r.total_cost_usd, viaStructured, raw: r.structured_output || r.result };
}

function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

// 必要な項目がそろっているか。1つでも欠けていれば null（＝失敗として扱う）
function validateReview(o) {
  const isStr = (v) => typeof v === 'string' && v.trim() !== '';
  if (!o || typeof o !== 'object') return null;
  const a = o.answers_request;
  if (!a || !['はい', '一部', 'いいえ'].includes(a.verdict) || !isStr(a.reason)) return null;
  if (!Array.isArray(o.findings) || !Array.isArray(o.out_of_scope)) return null;
  if (!o.findings.every((f) => f && ['必須', '推奨', '好み'].includes(f.severity) && isStr(f.issue))) return null;
  if (!o.out_of_scope.every((f) => f && isStr(f.proposal))) return null;
  return o;
}

// ---------- 整形と検査 ----------

function numberRound(round, review) {
  return {
    round,
    verdict: review.answers_request,
    findings: review.findings.map((f, i) => ({ id: `R${round}-${i + 1}`, ...f })),
    oos: review.out_of_scope.map((f, i) => ({ id: `O${round}-${i + 1}`, ...f })),
    hasMust: review.findings.some((f) => f.severity === '必須'),
  };
}

function formatFindings(r) {
  const lines = [];
  for (const f of r.findings) {
    lines.push(`${f.id} [${f.severity}]（${f.aspect}）${f.issue}`);
    if (f.evidence) lines.push(`  根拠: ${f.evidence}`);
    if (f.suggestion) lines.push(`  提案: ${f.suggestion}`);
  }
  for (const o of r.oos) lines.push(`${o.id} [範囲外] ${o.proposal} — ${o.reason}`);
  if (lines.length === 0) lines.push(`（${r.round}回目: 指摘なし）`);
  return lines.join('\n');
}

// 一覧に欠けがあれば、その説明を返す。無ければ null
function checkTable(plan, rounds) {
  const missing = [];
  for (const r of rounds) {
    const ids = [...r.findings, ...r.oos].map((f) => f.id);
    if (ids.length === 0) {
      if (!plan.includes(MARK_NONE)) missing.push(`「${MARK_NONE}」の行（${r.round}回目）`);
      continue;
    }
    if (!plan.includes(TABLE_HEADING)) missing.push(`「## ${TABLE_HEADING}」の節`);
    for (const id of ids) {
      if (!new RegExp(`(^|[^0-9A-Za-z-])${id}(?![0-9])`).test(plan)) missing.push(id);
    }
  }
  return missing.length > 0 ? [...new Set(missing)].join('、') : null;
}

const NEXT_REVIEW = '次の ExitPlanMode の呼び出しで、直したプランをもう一度レビューする（これが最後のレビュー）。呼ぶ前に、チャットに「自動レビュー中（数分かかることがあります）」と一言書く。';
const NEXT_USER = '次の ExitPlanMode の呼び出しは本人に届く（自動レビューはもう走らない）。呼ぶ前に、プランの全文を ```` で囲んだ1つのコードブロックでチャットに出す。「自動レビュー中」とは書かない。';

function reviewMessage(r, next) {
  const total = r.findings.length + r.oos.length;
  const head = [
    `【プランの自動レビュー（${r.round}回目）】これはフックによる差し戻しで、本人の差し戻しではない。`,
    '別の文脈の Claude が、本人の依頼原文とこのプランを照らしてレビューした。',
    `依頼に答えているか: ${r.verdict.verdict} — ${r.verdict.reason}`,
  ];
  if (total === 0) {
    return [...head, '', '指摘はなかった。', '', '## やること',
      `1. プランファイルの末尾に「${MARK_NONE}」と1行足す。`,
      `2. ${next}`].join('\n');
  }
  return [...head, '', '## 指摘', formatFindings(r), '', '## やること',
    '1. 指摘を鵜呑みにせず、1件ずつ「取り込んだ／取り込まない／要確認」に分け、理由を一言書く。',
    '2. 範囲外の提案（O で始まる番号）は取り込まない。本人の判断待ちに並べる。R の指摘でも、依頼の範囲を広げるものは取り込まずに「要確認」にする。',
    `3. プランファイルの末尾に次の節を足す（既にあれば行を足して更新する。前の回の行も消さない）:\n## ${TABLE_HEADING}\n| # | 重要度 | 指摘（要旨） | 対応 | 理由 |\n（R の番号を1件1行）\n### 範囲外の提案（あなたの判断待ち）\n（O の番号を1件1行）`,
    `4. ${next}`].join('\n');
}

function failureMessage(reason) {
  return [
    '【プランの自動レビュー】レビューを実行できなかった。これはフックによる差し戻しで、本人の差し戻しではない。',
    `理由: ${reason}`,
    '',
    '## やること',
    `1. プランファイルの末尾に「自動レビュー: 失敗（${reason.slice(0, 80)}）」と1行足す。`,
    `2. ${NEXT_USER}`,
  ].join('\n');
}

function missingMessage(missing, next) {
  return [
    '【プランの自動レビュー】指摘一覧に欠けがある。これはフックによる差し戻しで、本人の差し戻しではない。',
    `欠けているもの: ${missing}`,
    '',
    '## やること',
    `1. プランファイル末尾の「## ${TABLE_HEADING}」に、欠けている番号の行（対応と理由）を足す。指摘なしの回は「${MARK_NONE}」の行を足す。`,
    `2. ${next}`,
  ].join('\n');
}

// ---------- 本体 ----------

async function main() {
  if (process.env.PLAN_REVIEW_CHILD) pass(); // 子のセッションでは何もしない

  const raw = await readStdin();
  const input = JSON.parse(raw);
  if (input.tool_name !== 'ExitPlanMode') pass();
  const sid = String(input.session_id || 'unknown').replace(/[^0-9A-Za-z-]/g, '');
  const plan = String((input.tool_input && input.tool_input.plan) || '');

  // ① 状態ファイルを書けるか（書けなければ子を起動せずに通す）
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, '.probe'), '', 'utf8');
  } catch { pass(); }
  cleanupOld();

  const testMode = loadTestMode();
  let state = loadState(sid) || { stage: 'none' };

  try {
    if (testMode.fail === 'throw') throw new Error('テスト用の例外');

    const humans = readHumans(input.transcript_path);
    const req = pickRequest(humans);
    if (!req) throw new Error('transcript に本人の発言が見つからなかった');

    // 最新の人の発言が変わったら最初から
    if (state.lastHumanUuid !== req.latestUuid) {
      state = { stage: 'none', lastHumanUuid: req.latestUuid, rounds: [], bounced: false };
    }

    const cwd = [process.env.CLAUDE_PROJECT_DIR, input.cwd].find((d) => d && fs.existsSync(d)) || process.cwd();
    const doReview = async (round) => {
      const prompt = buildPrompt(req, plan, round, state.rounds);
      log(sid, { stage: state.stage, action: `review${round}-start`, hook: HOOK_FILE, request: req.original.text, preceding: req.preceding.map((h) => h.text), extra: req.extra.map((h) => h.text), prompt });
      const res = await runReviewer(prompt, cwd, testMode);
      log(sid, { stage: state.stage, action: `review${round}-end`, ok: res.ok, reason: res.reason, sec: res.sec, usage: res.usage, costUsdApiEquivalent: res.costUsdApiEquivalent, viaStructured: res.viaStructured, raw: res.raw });
      return res;
    };
    const fail = (reason) => {
      state.stage = 'done';
      state.failed = reason;
      try { saveState(sid, state); } catch { pass(); } // ③ 書けなければ通す
      deny(failureMessage(reason));
    };

    switch (state.stage) {
      case 'none': {
        const res = await doReview(1);
        if (!res.ok) fail(res.reason);
        const r = numberRound(1, res.review);
        state.rounds = [r];
        state.stage = r.hasMust ? 'wait1' : 'final';
        state.bounced = false;
        try { saveState(sid, state); } catch { pass(); } // ② deny の前に書く
        deny(reviewMessage(r, r.hasMust ? NEXT_REVIEW : NEXT_USER));
        break;
      }
      case 'wait1': {
        const missing = checkTable(plan, state.rounds);
        if (missing && !state.bounced) {
          state.bounced = true;
          try { saveState(sid, state); } catch { pass(); }
          log(sid, { stage: 'wait1', action: 'bounce', missing });
          deny(missingMessage(missing, NEXT_REVIEW));
        }
        const res = await doReview(2);
        if (!res.ok) fail(res.reason);
        const r = numberRound(2, res.review);
        state.rounds = [...state.rounds, r];
        state.stage = 'wait2';
        state.bounced = false;
        try { saveState(sid, state); } catch { pass(); }
        deny(reviewMessage(r, NEXT_USER));
        break;
      }
      case 'wait2':
      case 'final': {
        const missing = checkTable(plan, state.rounds);
        if (missing && !state.bounced) {
          state.bounced = true;
          try { saveState(sid, state); } catch { pass(); }
          log(sid, { stage: state.stage, action: 'bounce', missing });
          deny(missingMessage(missing, NEXT_USER));
        }
        const from = state.stage;
        state.stage = 'done';
        state.bounced = false;
        try { saveState(sid, state); } catch { /* 通すので問題ない */ }
        log(sid, { stage: from, action: 'pass', missingAtPass: missing || null });
        pass();
        break;
      }
      default:
        pass(); // done
    }
  } catch (e) {
    const reason = 'フックの中で例外: ' + (e && e.message ? e.message : String(e));
    log(sid, { stage: state.stage, action: 'exception', reason });
    if (state.stage === 'done') pass();
    state.stage = 'done';
    state.failed = reason;
    try { saveState(sid, state); } catch { pass(); }
    deny(failureMessage(reason));
  }
}

main().catch(() => pass());
