#!/bin/bash
# 从 src/assets/logo.png 生成安卓全套启动屏图片（白底 + logo 居中）
# 留白色 FDFDFB 与 logo 原图底色一致，避免拼接接缝
#
# 底图比例取 20:9，贴近现代手机屏幕，CENTER_CROP 时几乎不放大不发糊
# logo 尺寸取短边的 35%，上限 1024px（源图原生分辨率）
#
# 同时生成 Android 12+ 系统启动屏图标 splash_icon（288dp 画布，logo 占 70% 居中，
# 供 styles.xml 的 windowSplashScreenAnimatedIcon 使用，替代低分辨率的 ic_launcher_foreground）
#
# 生成后经 flatten-logo.py 把留白区的 AI 噪点拍平为纯色再重压缩，
# 体积可缩小约 85%，分辨率与视觉效果不变
set -e
cd "$(dirname "$0")/.."
SRC=src/assets/logo.png
RES=android/app/src/main/res
FLATTEN="python3 scripts/flatten-logo.py"

gen() { # 目录 宽 高
  local dir="$RES/$1" w=$2 h=$3
  local short=$(( w < h ? w : h ))
  local logo=$(( short * 35 / 100 ))
  [ $logo -gt 1024 ] && logo=1024
  mkdir -p "$dir"
  sips -s format png -z "$logo" "$logo" "$SRC" --out "$dir/splash.png" >/dev/null
  sips --padToHeightWidth "$h" "$w" --padColor FDFDFB "$dir/splash.png" >/dev/null 2>&1
  $FLATTEN "$dir/splash.png" "$dir/splash.png" >/dev/null
  echo "$1: ${w}x${h} (logo ${logo}px, $(du -h "$dir/splash.png" | cut -f1))"
}

gen_icon() { # 目录 画布px（288dp 对应密度换算）
  local dir="$RES/$1" canvas=$2
  local logo=$(( canvas * 70 / 100 ))
  [ $logo -gt 1024 ] && logo=1024
  mkdir -p "$dir"
  sips -s format png -z "$logo" "$logo" "$SRC" --out "$dir/splash_icon.png" >/dev/null
  sips --padToHeightWidth "$canvas" "$canvas" --padColor FDFDFB "$dir/splash_icon.png" >/dev/null 2>&1
  $FLATTEN "$dir/splash_icon.png" "$dir/splash_icon.png" >/dev/null
  echo "$1: splash_icon ${canvas}px (logo ${logo}px, $(du -h "$dir/splash_icon.png" | cut -f1))"
}

gen drawable 360 780
gen drawable-land-mdpi 780 360
gen drawable-land-hdpi 1170 540
gen drawable-land-xhdpi 1560 720
gen drawable-land-xxhdpi 2340 1080
gen drawable-land-xxxhdpi 3120 1440
gen drawable-port-mdpi 360 780
gen drawable-port-hdpi 540 1170
gen drawable-port-xhdpi 720 1560
gen drawable-port-xxhdpi 1080 2340
gen drawable-port-xxxhdpi 1440 3120

gen_icon drawable-mdpi 288
gen_icon drawable-hdpi 432
gen_icon drawable-xhdpi 576
gen_icon drawable-xxhdpi 864
gen_icon drawable-xxxhdpi 1152
echo "done"
