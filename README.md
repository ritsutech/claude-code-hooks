# claude-code-hooks

Claude Code のフック集です。

| フック | 何をするか |
|---|---|
| [guard-main](#guard-main) | 指定したリポジトリの main へ、Claude が commit / push するのを止める。PR のマージも止める |
| [plan-review](#plan-review) | プランモードのプランを本人に見せる前に、別の文脈の Claude にレビューさせる |

## guard-main

main にマージすると自動で公開・デプロイされるリポジトリで、Claude が main を直接触らないようにする PreToolUse フックです。
GitHub のブランチ保護を使えないとき（無料プランの Private リポジトリなど）の守りになります。

- 止めるもの: 守るブランチでの `git commit`、守るブランチへの `git push`（`--all` `--mirror` も）、`gh pr merge`、`gh api` での PR のマージ
- 「確認を出す（ask）」ではなく止めます。auto mode では確認が本人に届かず通ってしまうためです
- 操作先のリポジトリが読み取れないときだけ、確認を出します

### 必要なもの

- Windows PowerShell 5.1（Windows に最初から入っています）
- git、gh

### 設定

`.claude/settings.json` に書きます。パスは置いた場所に合わせてください。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/path/to/claude-code-hooks/guard-main/guard-main.ps1", "-Repo", "my-blog"]
          }
        ]
      }
    ]
  }
}
```

| 引数 | 意味 | 省略したとき |
|---|---|---|
| `-Repo` | 守るリポジトリ。remote の URL に含まれる文字で判定する。複数はカンマ区切り（`"my-blog,my-site"`） | すべてのリポジトリを守る |
| `-Branch` | 守るブランチ | `main` |

`gh pr merge` は `-Repo` に関係なく、どのリポジトリでも止めます。

### 確かめ方

設定したあと、Claude Code に `gh pr merge --help を実行して` と頼み、`guard-main: BLOCKED.` が出れば効いています。

## plan-review

プランモードを出る（ExitPlanMode）ときに動く PreToolUse フックです。プランが本人に届く前に、`claude -p` で別の文脈の Claude を起動し、本人の依頼の原文とプランを照らしてレビューさせます。指摘はフックの差し戻しとして Claude に返り、Claude がプランを直してから本人に届きます。

- レビューは最大2回。1回目に「必須」の指摘があったときだけ、直したプランを2回目にレビューする
- Claude はプランの末尾に「自動レビューの指摘一覧」（指摘ごとに、取り込んだ／取り込まない／要確認と理由）を足す。範囲を広げる提案は取り込まず、本人の判断待ちに並べる
- レビュー役は読むだけ（Read / Grep / Glob）。依頼の原文は会話の記録（transcript）から、本人が書いた文をそのまま取り出して渡す
- レビューに失敗したとき（claude が見つからない、時間切れなど）は、その旨をプランに書かせて本人に届ける。黙って素通りにはしない
- レビュー役の観点は、同じフォルダの `plan-reviewer.md` に書いてある。変えたいときはこのファイルを直す

### 必要なもの

- Node.js（18 以降）
- Claude Code の `claude` コマンド。Windows はネイティブ版の `claude.exe` が要る（npm 版の `claude.cmd` は shell なしでは起動できないため使えない）

確かめた OS は Windows だけです。Mac / Linux 向けの書き方（`claude` を PATH から探す、時間切れのときにプロセスのグループごと止める）は入れてありますが、動かしたことはありません。

### 設定

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["/path/to/claude-code-hooks/plan-review/plan-review-hook.mjs"],
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

- `timeout` は 600 にする。レビューは 480 秒で打ち切る（フックの時間切れより前に止めるため）
- `claude` が PATH にも `~/.local/bin` にも無いときは、環境変数 `PLAN_REVIEW_CLAUDE` に場所を書く
- 設定は起動中のチャットには効かないことがあります。新しいチャットで試してください

### 状態とログ

一時フォルダ（Windows は `%TEMP%`）の `claude-plan-review/` に、セッションごとの状態とログを置きます。30日より古いものは、フックが動いたときに消します。

- 失敗の回数: `log-*.jsonl` の `action` が `review1-end` / `review2-end` で `ok` が `false` の行
- 動いたスクリプトの場所: `review1-start` の行の `hook`

### テスト

`claude-plan-review/test-mode.json` に次を置くと、失敗を起こせます。**終わったら必ず消してください**（置いたままだと、本番のレビューが全部失敗します）。

| 中身 | 起きること |
|---|---|
| `{"fail":"child"}` | 子のセッションの起動に失敗する |
| `{"fail":"throw"}` | フックの中で例外が起きる |
| `{"timeoutMs":5000}` | 5秒で打ち切る |
| `{"fakeStdout":"..."}` | 子の出力を差し替える（レビューの結果の形を試すとき） |

## ライセンス

MIT
