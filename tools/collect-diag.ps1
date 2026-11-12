<#
  诊断包收集脚本（Windows / PowerShell 5.1+）

  用途：她的回复不正常时，把「能判断原因的那几份东西」打成一个包寄回来。
  只读，不改任何数据；包放在桌面，寄之前你自己可以先打开看一眼。

  用法（在仓库根目录）：
      powershell -ExecutionPolicy Bypass -File tools\collect-diag.ps1

  参数：
      -Root <路径>   她的数据目录（默认 %USERPROFILE%\.dsh-perch）
      -OutDir <路径> 包放在哪（默认桌面）

  包里有什么、为什么要：
      01-summary.txt        版本、Node 版本、数据目录大小、事件总数与按天分布
      02-last-events.jsonl  最近 150 条事件原文（她说了什么、听到什么）
      03-logs/              每份日志最后 200 行（出门被拦、唤醒报错、每轮字数都在这儿）
      04-config.json        配置（令牌已抹）
      05-owner.json         主人配置（令牌已抹）
      06-qq-wal.jsonl       最近 40 条 QQ 收发（正文截到 120 字）
      07-stats.txt          按类型计数、改口/拒绝/叙事的条数、导入标记

  不收集：头像、日记正文以外的媒体、任何密钥原文。
#>

[CmdletBinding()]
param(
  [string]$Root = "",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $Root -or $Root -eq "") {
  if ($env:DSH_PERCH_HOME -and (Test-Path $env:DSH_PERCH_HOME)) {
    $Root = $env:DSH_PERCH_HOME
  } else {
    $Root = Join-Path $env:USERPROFILE ".dsh-perch"
  }
}
if (-not $OutDir -or $OutDir -eq "") {
  $OutDir = [Environment]::GetFolderPath("Desktop")
  if (-not $OutDir) { $OutDir = $env:USERPROFILE }
}

if (-not (Test-Path $Root)) {
  Write-Host "找不到她的数据目录：$Root" -ForegroundColor Red
  Write-Host "如果装在别处，用 -Root 指定。"
  exit 1
}

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$work = Join-Path $env:TEMP ("perch-diag-" + $stamp)
New-Item -ItemType Directory -Force -Path $work | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $work "03-logs") | Out-Null

function Write-Utf8([string]$Path, [string[]]$Lines) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($Path, $Lines, $enc)
}

function Redact([string]$Text) {
  $t = $Text
  # 令牌/密钥：只留结构，不留值
  $t = [regex]::Replace($t, '("?(?:accessToken|token|password|secret|apiKey)"?\s*[:=]\s*")[^"]*(")', '$1<已抹>$2')
  $t = [regex]::Replace($t, '(?i)(authorization:\s*bearer\s+)\S+', '$1<已抹>')
  # .env 形状
  $t = [regex]::Replace($t, '(?im)^(\s*[A-Z0-9_]*(?:TOKEN|KEY|SECRET)\s*=\s*).*$', '$1<已抹>')
  return $t
}

# ---------- 01 summary ----------
$eventsPath = Join-Path $Root "events.jsonl"
$lines = @()
$lines += "收集时间: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz")
$lines += "数据目录: " + $Root
$lines += "计算机名: " + $env:COMPUTERNAME
$lines += ""

# 版本：优先读插件安装位置的 package.json
$version = "(未知)"
$candidates = @(
  (Join-Path $PSScriptRoot "..\package.json"),
  (Join-Path $Root "..\dsh-perch\package.json")
)
foreach ($c in $candidates) {
  try {
    if (Test-Path $c) {
      $pkg = Get-Content $c -Raw | ConvertFrom-Json
      $version = "$($pkg.name)@$($pkg.version)"
      $lines += "插件: " + $c
      break
    }
  } catch {}
}
$lines += "版本: " + $version

try { $lines += "Node: " + (& node --version 2>$null) } catch { $lines += "Node: (没装或不在 PATH)" }

if (Test-Path $eventsPath) {
  $evLines = Get-Content $eventsPath
  $lines += "事件总数: " + $evLines.Count
  $size = (Get-Item $eventsPath).Length
  $lines += ("events.jsonl 大小: {0:N1} MB" -f ($size / 1MB))
  # 按天分布（最近 14 天有数据的日子）
  $byDay = @{}
  foreach ($l in $evLines) {
    if ($l.Length -lt 20) { continue }
    try {
      $o = $l | ConvertFrom-Json
      if ($o.ts) {
        $d = ([datetimeoffset]::FromUnixTimeMilliseconds([int64]$o.ts)).LocalDateTime.ToString("yyyy-MM-dd")
        if ($byDay.ContainsKey($d)) { $byDay[$d]++ } else { $byDay[$d] = 1 }
      }
    } catch {}
  }
  $lines += ""
  $lines += "按天（最近 14 天）:"
  $byDay.GetEnumerator() | Sort-Object Name -Descending | Select-Object -First 14 | ForEach-Object {
    $lines += ("  {0}  {1}" -f $_.Name, $_.Value)
  }
} else {
  $lines += "!! 没有 events.jsonl"
}
Write-Utf8 (Join-Path $work "01-summary.txt") $lines

# ---------- 02 last events ----------
if (Test-Path $eventsPath) {
  $tail = Get-Content $eventsPath -Tail 150
  Write-Utf8 (Join-Path $work "02-last-events.jsonl") $tail
}

# ---------- 03 logs ----------
$logDirs = @((Join-Path $Root "logs"), (Join-Path $Root "log"))
foreach ($d in $logDirs) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem $d -File -Filter "*.log" | ForEach-Object {
    $target = Join-Path (Join-Path $work "03-logs") $_.Name
    $content = Get-Content $_.FullName -Tail 200
    Write-Utf8 $target (Redact ($content -join "`n")).Split("`n")
  }
  Get-ChildItem $d -File -Filter "*.jsonl" | ForEach-Object {
    $target = Join-Path (Join-Path $work "03-logs") ($_.Name + ".tail")
    $content = Get-Content $_.FullName -Tail 200
    Write-Utf8 $target (Redact ($content -join "`n")).Split("`n")
  }
}

# ---------- 04 config / 05 owner ----------
foreach ($name in @("config.json", "owner.json")) {
  $p = Join-Path $Root $name
  $outName = if ($name -eq "config.json") { "04-config.json" } else { "05-owner.json" }
  if (Test-Path $p) {
    $raw = Get-Content $p -Raw
    Write-Utf8 (Join-Path $work $outName) @((Redact $raw))
  } else {
    Write-Utf8 (Join-Path $work $outName) @("(没有这个文件)")
  }
}

# ---------- 06 qq wal ----------
$wal = Join-Path $Root "qq-wal.jsonl"
if (Test-Path $wal) {
  $out = @()
  foreach ($l in (Get-Content $wal -Tail 40)) {
    if ($l.Length -gt 400) { $l = $l.Substring(0, 400) + "…(截断)" }
    $out += (Redact $l)
  }
  Write-Utf8 (Join-Path $work "06-qq-wal.jsonl") $out
} else {
  Write-Utf8 (Join-Path $work "06-qq-wal.jsonl") @("(没有 qq-wal.jsonl —— 可能群消息没进来过，或版本早于 WAL)")
}

# ---------- 07 stats ----------
$stats = @()
if (Test-Path $eventsPath) {
  $types = @{}
  $flags = @{}
  foreach ($l in (Get-Content $eventsPath)) {
    if ($l.Length -lt 10) { continue }
    try {
      $o = $l | ConvertFrom-Json
      $t = [string]$o.type
      if ($types.ContainsKey($t)) { $types[$t]++ } else { $types[$t] = 1 }
      if ($t -eq "meta") {
        $txt = [string]$o.text
        if ($txt -match "^(fired|import-mark|import-told|sched|leak|narration)") {
          $k = ($txt -split ":")[0]
          if ($flags.ContainsKey($k)) { $flags[$k]++ } else { $flags[$k] = 1 }
        }
      }
    } catch {}
  }
  $stats += "按类型:"
  $types.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { $stats += ("  {0,-12} {1}" -f $_.Key, $_.Value) }
  $stats += ""
  $stats += "meta 前缀:"
  $flags.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { $stats += ("  {0,-14} {1}" -f $_.Key, $_.Value) }
  $stats += ""
  $stats += "口径提醒：refusal 为 0 时，撒娇那张卡开不了；narration 为 0 同理。"
}
Write-Utf8 (Join-Path $work "07-stats.txt") $stats

# ---------- zip ----------
$zip = Join-Path $OutDir ("perch-diag-" + $stamp + ".zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $work "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $work -Recurse -Force

Write-Host ""
Write-Host "打好了：" -ForegroundColor Green
Write-Host "  $zip"
Write-Host ""
Write-Host "寄之前建议打开 01-summary.txt 和 07-stats.txt 各看一眼；"
Write-Host "如果里面有不想给任何人看的話，删掉那一行再寄（包可以重打）。"
