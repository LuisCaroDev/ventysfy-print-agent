Add-Type -AssemblyName System.Drawing

$width = 256
$height = 256
$scale = [Math]::Min(($width * 0.84) / 103, ($height * 0.84) / 79)
$offsetX = ($width - (103 * $scale)) / 2
$offsetY = ($height - (79 * $scale)) / 2

function New-IconPoint([double]$x, [double]$y) {
  New-Object System.Drawing.PointF (($offsetX + ($x * $scale))), (($offsetY + ($y * $scale)))
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$black = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Black)
$greenBottom = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#46CE8E'))
$greenLeft = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#34C385'))

$right = @(
  (New-IconPoint 47.5 39),
  (New-IconPoint 71.412 0.936),
  (New-IconPoint 73.105 0),
  (New-IconPoint 96.823 0),
  (New-IconPoint 98.571 1.029),
  (New-IconPoint 102.385 9.997),
  (New-IconPoint 84.5 39)
)

$bottom = @(
  (New-IconPoint 17.5 39),
  (New-IconPoint 84.5 39),
  (New-IconPoint 60.089 77.57),
  (New-IconPoint 58.399 78.5),
  (New-IconPoint 43.113 78.5),
  (New-IconPoint 41.413 77.554)
)

$left = @(
  (New-IconPoint 0.49 11.785),
  (New-IconPoint 3.057 1.394),
  (New-IconPoint 4.962 0),
  (New-IconPoint 28.406 0),
  (New-IconPoint 30.09 0.921),
  (New-IconPoint 54.5 39),
  (New-IconPoint 17.5 39)
)

$graphics.FillPolygon($black, $right)
$graphics.FillPolygon($greenBottom, $bottom)
$graphics.FillPolygon($greenLeft, $left)
$graphics.Dispose()

$pngPath = Join-Path $PSScriptRoot '..\build\icon.png'
$icoPath = Join-Path $PSScriptRoot '..\build\icon.ico'

$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

$png = [System.IO.File]::ReadAllBytes($pngPath)
$stream = [System.IO.File]::Create($icoPath)
$writer = New-Object System.IO.BinaryWriter($stream)

$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$png.Length)
$writer.Write([UInt32]22)
$writer.Write($png)

$writer.Close()
$stream.Close()
