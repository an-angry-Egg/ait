# 启动 AIT Demo 演示页
# 用法：右键「使用 PowerShell 运行」，或在终端执行 .\start.ps1

$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$port = 5199
$url  = "http://127.0.0.1:$port/"

$alive = $false
try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing
    $alive = ($r.StatusCode -eq 200)
} catch { $alive = $false }

if ($alive) {
    "服务已在运行：$url"
} else {
    Start-Process -FilePath 'python' `
        -ArgumentList '-m', 'http.server', $port, '--bind', '127.0.0.1' `
        -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 1
    "已启动：$url"
    "（python 进程在后台运行，关闭时可在任务管理器结束）"
}

Start-Process $url

@"

下一步：
  1. 打开 chrome://extensions/ ，开启右上角「开发者模式」
  2. 点「加载已解压的扩展程序」，选择：$root\extension
  3. 刷新页面，右上角出现蓝色「点睛」圆钮即成功
"@
