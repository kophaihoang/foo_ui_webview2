# Fetches the third-party libraries into automix\ext (not committed). Run once before building.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path ext\qm-dsp)) { git clone -q --depth 1 --branch qm-vamp-plugins-v1.8.0 https://github.com/c4dm/qm-dsp ext/qm-dsp }
if (-not (Test-Path ext\soundtouch)) { git clone -q --depth 1 --branch 2.4.1 https://codeberg.org/soundtouch/soundtouch ext/soundtouch }
