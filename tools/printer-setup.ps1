# 打印机设置窗口（Windows PowerShell 5.1 / WinForms）
# 读写 %USERPROFILE%\.print3d\printer.json —— 与 dsh-print3d 插件共用的单一配置源。
# 本文件必须保存为 UTF-8 with BOM，否则 5.1 会把中文读成乱码。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference = 'Stop'
$ProfileDir  = Join-Path $env:USERPROFILE '.print3d'
$ProfilePath = Join-Path $ProfileDir 'printer.json'

$Defaults = [ordered]@{
  name = 'Prusa i3'; material = 'PLA'; firmware = 'Marlin'
  nozzle = 0.4; filament_diameter = 1.75
  bed_width = 200; bed_depth = 200; bed_height = 180
  slicer = 'auto'; prusa_slicer_path = ''; cura_engine_path = ''
  layer_height = 0.2; first_layer_height = 0.3
  nozzle_temp = 200; bed_temp = 60
  speed = 50; travel_speed = 120
  infill = 20; walls = 2; top_bottom_layers = 3; brim_mm = 0
}
$NumericKeys = @('nozzle','filament_diameter','bed_width','bed_depth','bed_height',
  'layer_height','first_layer_height','nozzle_temp','bed_temp','speed','travel_speed',
  'infill','walls','top_bottom_layers','brim_mm')

function Read-Profile {
  $out = [ordered]@{}
  foreach ($k in $Defaults.Keys) { $out[$k] = $Defaults[$k] }
  if (Test-Path $ProfilePath) {
    try {
      $raw = Get-Content $ProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($k in $Defaults.Keys) {
        $v = $raw.$k
        if ($null -eq $v) { continue }
        if ($v -is [string] -and $v -eq '') { continue }
        if ($NumericKeys -contains $k) { $out[$k] = [double]$v } else { $out[$k] = [string]$v }
      }
    } catch {
      [System.Windows.Forms.MessageBox]::Show("配置文件读取失败，将使用默认值。`n$ProfilePath`n`n$($_.Exception.Message)", '警告') | Out-Null
    }
  }
  return $out
}

function Save-Profile($values) {
  if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null }
  $obj = [ordered]@{}
  foreach ($k in $values.Keys) { $obj[$k] = $values[$k] }
  $json = ($obj | ConvertTo-Json -Depth 4)
  $tmp = "$ProfilePath.tmp"
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
  Move-Item -Force $tmp $ProfilePath
}

# ---- 字段定义：Label / key / 类型 / 选项 ----
$Sections = @(
  @{ Title = '打印机'; Fields = @(
      @{ Key='name';        Label='名称';       Type='text' }
      @{ Key='material';    Label='材料';       Type='combo'; Options=@('PLA','ABS','ASA','PETG','TPU','尼龙') }
      @{ Key='firmware';    Label='固件';       Type='combo'; Options=@('Marlin','Klipper','RepRap','其他') }
      @{ Key='bed_width';   Label='床宽 mm';    Type='num'; Dec=0; Inc=5; Min=50; Max=1000 }
      @{ Key='bed_depth';   Label='床深 mm';    Type='num'; Dec=0; Inc=5; Min=50; Max=1000 }
      @{ Key='bed_height';  Label='最大高 mm';  Type='num'; Dec=0; Inc=5; Min=10; Max=1000 }
  ) },
  @{ Title = '挤出与切片'; Fields = @(
      @{ Key='nozzle';            Label='喷嘴 mm';    Type='num'; Dec=2; Inc=0.1; Min=0.1; Max=2 }
      @{ Key='filament_diameter'; Label='耗材 mm';    Type='combo'; Options=@('1.75','2.85') }
      @{ Key='slicer';            Label='切片后端';   Type='combo'; Options=@('auto','prusa','cura') }
      @{ Key='cura_engine_path';  Label='CuraEngine'; Type='file' }
      @{ Key='prusa_slicer_path'; Label='PrusaSlicer';Type='file' }
  ) },
  @{ Title = '工艺参数'; Fields = @(
      @{ Key='layer_height';       Label='层高 mm';   Type='num'; Dec=2; Inc=0.05; Min=0.05; Max=1 }
      @{ Key='first_layer_height'; Label='首层 mm';   Type='num'; Dec=2; Inc=0.05; Min=0.05; Max=1 }
      @{ Key='nozzle_temp';        Label='喷嘴 ℃';    Type='num'; Dec=0; Inc=5; Min=0; Max=320 }
      @{ Key='bed_temp';           Label='热床 ℃';    Type='num'; Dec=0; Inc=5; Min=0; Max=150 }
      @{ Key='speed';              Label='速度 mm/s'; Type='num'; Dec=0; Inc=5; Min=5; Max=500 }
      @{ Key='travel_speed';       Label='空驶 mm/s'; Type='num'; Dec=0; Inc=10; Min=10; Max=800 }
      @{ Key='infill';             Label='填充 %';    Type='num'; Dec=0; Inc=5; Min=0; Max=100 }
      @{ Key='walls';              Label='墙数';      Type='num'; Dec=0; Inc=1; Min=1; Max=10 }
      @{ Key='top_bottom_layers';  Label='顶底实心层';Type='num'; Dec=0; Inc=1; Min=0; Max=20 }
      @{ Key='brim_mm';            Label='底边 mm';   Type='num'; Dec=1; Inc=1; Min=0; Max=30 }
  ) }
)

$profile = Read-Profile
$controls = @{}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 3D 打印 —— 打印机设置'
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.ClientSize = New-Object System.Drawing.Size(720, 560)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$y = 10
foreach ($sec in $Sections) {
  $cols = 4
  $rows = [math]::Ceiling($sec.Fields.Count / 2)
  $boxH = 30 + $rows * 32
  $box = New-Object System.Windows.Forms.GroupBox
  $box.Text = $sec.Title
  $box.Location = New-Object System.Drawing.Point(12, $y)
  $box.Size = New-Object System.Drawing.Size(696, $boxH)
  $form.Controls.Add($box)

  $idx = 0
  foreach ($f in $sec.Fields) {
    $col = $idx % 2
    $row = [math]::Floor($idx / 2)
    $lx = 14 + $col * 344
    $ly = 24 + $row * 32

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $f.Label
    $lbl.Location = New-Object System.Drawing.Point($lx, ($ly + 3))
    $lbl.Size = New-Object System.Drawing.Size(78, 20)
    $box.Controls.Add($lbl)

    $cx = $lx + 80
    $cw = 250
    $val = $profile[$f.Key]

    switch ($f.Type) {
      'combo' {
        $c = New-Object System.Windows.Forms.ComboBox
        $c.DropDownStyle = 'DropDownList'
        foreach ($o in $f.Options) { [void]$c.Items.Add($o) }
        $c.Location = New-Object System.Drawing.Point($cx, $ly)
        $c.Size = New-Object System.Drawing.Size(120, 22)
        $sval = "$val"
        if ($c.Items.Contains($sval)) { $c.SelectedItem = $sval } else { $c.SelectedIndex = 0 }
        $box.Controls.Add($c)
      }
      'num' {
        $c = New-Object System.Windows.Forms.NumericUpDown
        $c.DecimalPlaces = $f.Dec
        $c.Increment = [decimal]$f.Inc
        $c.Minimum = [decimal]$f.Min
        $c.Maximum = [decimal]$f.Max
        $c.Location = New-Object System.Drawing.Point($cx, $ly)
        $c.Size = New-Object System.Drawing.Size(90, 22)
        $dv = [decimal]$val
        if ($dv -lt $c.Minimum) { $dv = $c.Minimum }
        if ($dv -gt $c.Maximum) { $dv = $c.Maximum }
        $c.Value = $dv
        $box.Controls.Add($c)
      }
      'file' {
        $c = New-Object System.Windows.Forms.TextBox
        $c.Text = "$val"
        $c.Location = New-Object System.Drawing.Point($cx, $ly)
        $c.Size = New-Object System.Drawing.Size(174, 22)
        $box.Controls.Add($c)
        $b = New-Object System.Windows.Forms.Button
        $b.Text = '...'
        $b.Location = New-Object System.Drawing.Point(($cx + 178), $ly)
        $b.Size = New-Object System.Drawing.Size(30, 23)
        $b.Tag = $c
        $b.Add_Click({
          $dlg = New-Object System.Windows.Forms.OpenFileDialog
          $dlg.Filter = '可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*'
          if ($dlg.ShowDialog() -eq 'OK') { $this.Tag.Text = $dlg.FileName }
        })
        $box.Controls.Add($b)
      }
      default {
        $c = New-Object System.Windows.Forms.TextBox
        $c.Text = "$val"
        $c.Location = New-Object System.Drawing.Point($cx, $ly)
        $c.Size = New-Object System.Drawing.Size(120, 22)
        $box.Controls.Add($c)
      }
    }
    $controls[$f.Key] = $c
    $idx++
  }
  $y += $boxH + 8
}

# ---- 底部按钮 ----
$btnY = $y + 2
$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Text = '保存'
$btnSave.Location = New-Object System.Drawing.Point(12, $btnY)
$btnSave.Size = New-Object System.Drawing.Size(90, 28)
$form.Controls.Add($btnSave)

$btnReset = New-Object System.Windows.Forms.Button
$btnReset.Text = '恢复默认'
$btnReset.Location = New-Object System.Drawing.Point(110, $btnY)
$btnReset.Size = New-Object System.Drawing.Size(90, 28)
$form.Controls.Add($btnReset)

$btnOpen = New-Object System.Windows.Forms.Button
$btnOpen.Text = '打开配置文件'
$btnOpen.Location = New-Object System.Drawing.Point(208, $btnY)
$btnOpen.Size = New-Object System.Drawing.Size(110, 28)
$form.Controls.Add($btnOpen)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(330, ($btnY + 6))
$status.Size = New-Object System.Drawing.Size(378, 20)
$status.ForeColor = [System.Drawing.Color]::DimGray
$status.Text = "配置：$ProfilePath"
$form.Controls.Add($status)

function Collect-Values {
  $v = [ordered]@{}
  foreach ($k in $controls.Keys) {
    $c = $controls[$k]
    if ($c -is [System.Windows.Forms.NumericUpDown]) { $v[$k] = [double]$c.Value }
    elseif ($c -is [System.Windows.Forms.ComboBox]) { $v[$k] = [string]$c.SelectedItem }
    else { $v[$k] = $c.Text.Trim() }
  }
  return $v
}

$btnSave.Add_Click({
  try {
    Save-Profile (Collect-Values)
    $status.Text = "已保存 $(Get-Date -Format 'HH:mm:ss') —— 重启 DSH 后生效"
    $status.ForeColor = [System.Drawing.Color]::ForestGreen
  } catch {
    [System.Windows.Forms.MessageBox]::Show("保存失败：$($_.Exception.Message)", '错误') | Out-Null
  }
})

$btnReset.Add_Click({
  $r = [System.Windows.Forms.MessageBox]::Show('恢复为内置默认值？', '确认', 'YesNo', 'Question')
  if ($r -ne 'Yes') { return }
  foreach ($k in $Defaults.Keys) {
    $c = $controls[$k]
    if ($null -eq $c) { continue }
    if ($c -is [System.Windows.Forms.NumericUpDown]) { $c.Value = [decimal]$Defaults[$k] }
    elseif ($c -is [System.Windows.Forms.ComboBox]) { $c.SelectedItem = "$($Defaults[$k])" }
    else { $c.Text = "$($Defaults[$k])" }
  }
  $status.Text = '已恢复默认（尚未保存）'
  $status.ForeColor = [System.Drawing.Color]::DarkOrange
})

$btnOpen.Add_Click({
  if (Test-Path $ProfilePath) { Start-Process notepad.exe $ProfilePath }
  else { [System.Windows.Forms.MessageBox]::Show('配置文件还没生成，先点“保存”。', '提示') | Out-Null }
})

[void]$form.ShowDialog()
