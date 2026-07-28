#!/bin/bash
# 从 src/assets/logo.jpg 生成安卓全套启动屏图片（白底 + logo 居中）
# 留白色 FDFDFB 与 logo 原图底色一致，避免拼接接缝
# logo 尺寸取短边的 30%，上限 256px（原图分辨率，避免放大发糊）
set -e
cd "$(dirname "$0")/.."
SRC=src/assets/logo.jpg
RES=android/app/src/main/res

gen() { # 目录 宽 高
  local dir="$RES/$1" w=$2 h=$3
  local short=$(( w < h ? w : h ))
  local logo=$(( short * 30 / 100 ))
  [ $logo -gt 256 ] && logo=256
  sips -s format png -z "$logo" "$logo" "$SRC" --out "$dir/splash.png" >/dev/null
  sips --padToHeightWidth "$h" "$w" --padColor FDFDFB "$dir/splash.png" >/dev/null
  echo "$1: ${w}x${h} (logo ${logo}px)"
}

gen drawable 480 320
gen drawable-land-mdpi 480 320
gen drawable-land-hdpi 800 480
gen drawable-land-xhdpi 1280 720
gen drawable-land-xxhdpi 1600 960
gen drawable-land-xxxhdpi 1920 1280
gen drawable-port-mdpi 320 480
gen drawable-port-hdpi 480 800
gen drawable-port-xhdpi 720 1280
gen drawable-port-xxhdpi 960 1600
gen drawable-port-xxxhdpi 1280 1920
echo "done"
