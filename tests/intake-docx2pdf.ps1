# 用本机 Word 把 docx 只读打开并另存为 PDF（格式代码 17），用于视觉检查 Word 导出效果。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tests/intake-docx2pdf.ps1 <in.docx> <out.pdf>
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$inPath = (Resolve-Path $In).Path
$outPath = [System.IO.Path]::GetFullPath($Out)
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
  $doc = $word.Documents.Open($inPath, $false, $true, $false)
  try {
    $doc.Fields.Update() | Out-Null
    $doc.SaveAs2([ref]$outPath, [ref]17)
    Write-Output ("pages=" + $doc.ComputeStatistics(2))
  } finally {
    $doc.Close([ref]0)
  }
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
Write-Output "saved $outPath"
