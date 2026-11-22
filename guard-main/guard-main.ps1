# guard-main.ps1
# Claude Code の PreToolUse フック（Bash / PowerShell）。
# 指定したリポジトリの main へ、Claude が commit / push するのを止める。PR のマージ（gh pr merge など）も止める。
# main にマージすると自動で公開・デプロイされるリポジトリで、GitHub のブランチ保護を使えないときの守り。
# 「確認を出す（ask）」にしないのは、auto mode では確認が本人に届かず通ってしまうため。
#
# 使い方（.claude/settings.json の args）:
#   -File <このファイル> -Repo my-blog            my-blog のリポジトリだけ守る（remote の URL に含まれる文字で判定）
#   -File <このファイル> -Repo "my-blog,my-site"  複数のときはカンマで区切る
#   -Branch master                                 守るブランチ（省略時は main）
#   -Repo を省略すると、すべてのリポジトリの守るブランチを守る
#
# 結果:
#   exit 2              止める（理由は stderr。文字化けを避けて英語）
#   exit 0 + JSON(ask)  本人に確認する（操作先のリポジトリが読み取れないとき。auto mode では届かない）
#   exit 0              通す
# 想定外のこと（読み取りの失敗、例外）が起きたら止める側に倒す。
# ただし、git も gh も含まないコマンドはすぐ通す（スクリプトが壊れても、ほかの作業は止めない）。

param(
    [string]$Repo = '',
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

# -File で渡すと配列にならないので、カンマで自分で分ける
$RepoMarkers = @($Repo -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
$ProtectedBranch = $Branch.Trim()

function Block([string]$msg) {
    [Console]::Error.WriteLine("guard-main: BLOCKED. $msg Claude must not commit or push to the protected branch ($ProtectedBranch) of this repository, and must not merge pull requests. Use a branch and a pull request; the owner merges it.")
    exit 2
}

$raw = [Console]::In.ReadToEnd()
if ($raw -notmatch 'git|gh') { exit 0 }

try {
    $hookInput = $raw | ConvertFrom-Json
    $cmd = [string]$hookInput.tool_input.command
    $cwd = [string]$hookInput.cwd
    if ([string]::IsNullOrWhiteSpace($cmd)) {
        if ($hookInput.tool_name -in @('Bash', 'PowerShell')) { Block 'Could not read the command.' }
        exit 0
    }
    if ($cmd -notmatch '(?i)\b(git|gh)(\.exe)?\b') { exit 0 }

    $askReasons = New-Object System.Collections.Generic.List[string]

    # Git Bash の /c/... を C:/... に直す
    function Convert-PathText([string]$p) {
        $p = $p.Trim()
        if ($p -match '^/([a-zA-Z])(/.*)?$') { $p = $Matches[1] + ':' + $(if ($Matches[2]) { $Matches[2] } else { '/' }) }
        return $p
    }

    function Resolve-Dir([string]$base, [string]$target) {
        if ($null -eq $base) { return $null }
        if ([string]::IsNullOrWhiteSpace($target)) { return $null }
        if ($target -match '[\$~`%]' -or $target -eq '-') { return $null }
        $t = Convert-PathText $target
        if (-not [System.IO.Path]::IsPathRooted($t)) { $t = Join-Path $base $t }
        if (-not (Test-Path -LiteralPath $t -PathType Container)) { return $null }
        return (Resolve-Path -LiteralPath $t).ProviderPath
    }

    function Split-Tokens([string]$s) {
        $list = @()
        foreach ($m in [regex]::Matches($s, '"[^"]*"|''[^'']*''|\S+')) {
            $v = $m.Value
            if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
                $v = $v.Substring(1, $v.Length - 2)
            }
            $list += $v
        }
        return , $list
    }

    function Invoke-Git([string]$dir, [string[]]$gitArgs) {
        $out = & git -C $dir @gitArgs 2>$null
        return @{ Code = $LASTEXITCODE; Out = (($out | Out-String).Trim()) }
    }

    function Test-Marker([string]$text) {
        foreach ($m in $RepoMarkers) { if ($text -match [regex]::Escape($m)) { return $true } }
        return $false
    }

    # 操作先が守るリポジトリか。リポジトリでないフォルダは対象外
    function Test-GuardedRepo([string]$dir, [string[]]$tokens) {
        if ($RepoMarkers.Count -gt 0) {
            foreach ($t in $tokens) { if (Test-Marker $t) { return $true } }
        }
        $r = Invoke-Git $dir @('rev-parse', '--is-inside-work-tree')
        if ($r.Code -ne 0) { return $false }
        if ($RepoMarkers.Count -eq 0) { return $true }
        $r = Invoke-Git $dir @('remote', '-v')
        return (Test-Marker $r.Out)
    }

    function Get-Branch([string]$dir) {
        $r = Invoke-Git $dir @('branch', '--show-current')
        if ($r.Code -ne 0) { Block 'Could not read the current branch.' }
        return $r.Out
    }

    function Get-Upstream([string]$dir) {
        $r = Invoke-Git $dir @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
        if ($r.Code -ne 0) { return '' }
        return $r.Out
    }

    function Test-ProtectedRef([string]$ref, [string]$branch) {
        $r = $ref.TrimStart('+')
        if ($r -eq 'HEAD' -or $r -eq '@') { $r = $branch }
        $r = $r -replace '^refs/heads/', ''
        if ($r -match '\*') { return $true }
        return ($r -eq $ProtectedBranch)
    }

    function Test-Push([string]$dir, [string[]]$rest) {
        $valueOpts = @('--repo', '-o', '--push-option', '--receive-pack', '--exec')
        $positional = @()
        for ($i = 0; $i -lt $rest.Count; $i++) {
            $a = $rest[$i]
            if ($a -in @('--all', '--mirror', '--branches')) { Block "git push $a." }
            if ($a -in $valueOpts) { $i++; continue }
            if ($a.StartsWith('-')) { continue }
            $positional += $a
        }
        $branch = Get-Branch $dir
        $refspecs = @()
        if ($positional.Count -ge 2) { $refspecs = @($positional[1..($positional.Count - 1)]) }
        if ($refspecs.Count -eq 0) {
            if ($branch -eq $ProtectedBranch) { Block "git push without a refspec on $ProtectedBranch." }
            $up = Get-Upstream $dir
            if ($up -match ('(^|/)' + [regex]::Escape($ProtectedBranch) + '$')) { Block "git push without a refspec, and the upstream is $ProtectedBranch." }
            return
        }
        foreach ($spec in $refspecs) {
            $dst = $spec
            if ($spec.Contains(':')) { $dst = $spec.Substring($spec.LastIndexOf(':') + 1) }
            if ([string]::IsNullOrEmpty($dst)) { continue }
            if (Test-ProtectedRef $dst $branch) { Block "git push to $spec." }
        }
    }

    $dir = $cwd
    if (-not [string]::IsNullOrWhiteSpace($dir)) { $dir = Resolve-Dir $dir '.' }
    $stack = New-Object System.Collections.Stack

    $segments = [regex]::Split($cmd, '&&|\|\||;|\||\r?\n')
    foreach ($seg in $segments) {
        $tokens = Split-Tokens $seg
        if ($tokens.Count -eq 0) { continue }
        # 先頭の & や環境変数の代入を飛ばす
        $start = 0
        while ($start -lt $tokens.Count -and ($tokens[$start] -eq '&' -or $tokens[$start] -match '^[A-Za-z_][A-Za-z0-9_]*=')) { $start++ }
        if ($start -ge $tokens.Count) { continue }
        $tokens = @($tokens[$start..($tokens.Count - 1)])
        $head = ($tokens[0] -replace '\.exe$', '').ToLower()

        # 移動のコマンド
        if ($head -in @('cd', 'chdir', 'set-location', 'sl', 'push-location', 'pushd')) {
            $target = $null
            for ($i = 1; $i -lt $tokens.Count; $i++) {
                if ($tokens[$i] -in @('-Path', '-LiteralPath')) { continue }
                if ($tokens[$i].StartsWith('-') -and $tokens[$i] -ne '-') { continue }
                $target = $tokens[$i]; break
            }
            if ($head -in @('push-location', 'pushd')) { $stack.Push($dir) }
            $dir = Resolve-Dir $dir $target
            continue
        }
        if ($head -in @('pop-location', 'popd')) {
            if ($stack.Count -gt 0) { $dir = $stack.Pop() } else { $dir = $null }
            continue
        }

        # gh: PR のマージは止める（どのリポジトリでも）
        if ($head -eq 'gh') {
            $joined = ($tokens -join ' ')
            if ($joined -match '(?i)\bpr\s+merge\b') { Block 'gh pr merge.' }
            if ($joined -match '(?i)\bapi\b' -and $joined -match 'pulls/[^/\s]+/merge') { Block 'Merging a pull request through gh api.' }
            continue
        }

        if ($head -ne 'git') { continue }

        # git のグローバルオプション
        $gitDir = $dir
        $unknown = $false
        $i = 1
        while ($i -lt $tokens.Count -and $tokens[$i].StartsWith('-')) {
            $o = $tokens[$i]
            if ($o -eq '-C') { $gitDir = Resolve-Dir $gitDir $tokens[$i + 1]; if ($null -eq $gitDir) { $unknown = $true }; $i += 2; continue }
            if ($o -eq '-c') { $i += 2; continue }
            if ($o -match '^--(git-dir|work-tree)') { $unknown = $true; if ($o -notmatch '=') { $i++ }; $i++; continue }
            $i++
        }
        if ($i -ge $tokens.Count) { continue }
        $sub = $tokens[$i].ToLower()
        if ($sub -notin @('push', 'commit')) { continue }
        $rest = @()
        if ($i + 1 -lt $tokens.Count) { $rest = @($tokens[($i + 1)..($tokens.Count - 1)]) }

        if ($unknown -or $null -eq $gitDir) {
            $askReasons.Add("Could not tell which repository 'git $sub' runs in.")
            continue
        }
        if (-not (Test-GuardedRepo $gitDir $rest)) { continue }

        if ($sub -eq 'commit') {
            if ((Get-Branch $gitDir) -eq $ProtectedBranch) { Block "git commit on $ProtectedBranch." }
            continue
        }
        Test-Push $gitDir $rest
    }

    if ($askReasons.Count -gt 0) {
        $out = @{ hookSpecificOutput = @{
                hookEventName            = 'PreToolUse'
                permissionDecision       = 'ask'
                permissionDecisionReason = 'guard-main: ' + ($askReasons -join ' ')
            }
        }
        $out | ConvertTo-Json -Compress -Depth 5
        exit 0
    }
    exit 0
}
catch {
    Block ("Internal error in the hook: " + $_.Exception.Message)
}
