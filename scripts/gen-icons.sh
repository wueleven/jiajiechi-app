#!/bin/bash
# 从 src/assets/logo.png 生成安卓全套规范分辨率启动图标
# 每档密度：ic_launcher(方图) / ic_launcher_round / ic_launcher_foreground(适配性前景图，logo 居中占 61% 安全区)
# 留白色 FDFDFB 与 logo 原图底色一致，避免拼接接缝
set -e
cd "$(dirname "$0")/.."
SRC=src/assets/logo.png
RES=android/app/src/main/res

# 密度  launcher尺寸  前景画布  前景内logo尺寸
for spec in "mdpi 48 108 66" "hdpi 72 162 99" "xhdpi 96 216 132" "xxhdpi 144 324 198" "xxxhdpi 192 432 264"; do
  set -- $spec
  d="$RES/mipmap-$1"
  sips -s format png -z "$2" "$2" "$SRC" --out "$d/ic_launcher.png" >/dev/null
  cp "$d/ic_launcher.png" "$d/ic_launcher_round.png"
  sips -s format png -z "$4" "$4" "$SRC" --out "$d/ic_launcher_foreground.png" >/dev/null
  sips --padToHeightWidth "$3" "$3" --padColor FDFDFB "$d/ic_launcher_foreground.png" >/dev/null
  echo "mipmap-$1: launcher=$2px foreground=$3px(logo $4px)"
done
echo "done"
