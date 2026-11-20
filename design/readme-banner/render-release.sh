#!/bin/zsh
# Renders the LinkedIn release video: the animated icon on top, "Canvas <version>" under it,
# four rows of feature pills looping sideways. 1920x1080, 24 s, loops seamlessly.
# Before running, rewrite the pill rows in release-banner.html from the release notes.
# Run: design/readme-banner/render-release.sh 0.3.0
# Output: exports/canvas-<version>-linkedin.mp4 and .png (git-ignored).
set -euo pipefail
V=${1:?usage: render-release.sh <version>}
cd "${0:A:h}/exports"
H=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell | tail -1)
U="file://${PWD:h}/release-banner.html"
D=24; CW=1920
mkdir -p layers; rm -f layers/*
shot() { "$H" --hide-scrollbars --window-size=$1 --default-background-color=00000000 --virtual-time-budget=1500 --screenshot=$2 "$3" >/dev/null 2>&1; }
shot 1920,1080 layers/bg.png "$U?layer=bg"
shot 1920,1080 layers/head.png "$U?layer=head&v=$V"
for r in r1 r2 r3 r4; do
  W=$("$H" --window-size=8000,110 --virtual-time-budget=1500 --dump-dom "$U?layer=$r&measure=1" 2>/dev/null | grep -o 'W=[0-9]*' | head -1 | cut -d= -f2)
  echo "$r $W" >> layers/widths.txt
  shot $((W*3)),110 layers/$r.png "$U?layer=$r"
done
F="[0:v]format=rgba[bg];
[1:v]crop=560:560:260:300,scale=480:480,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(min(min(X\,479-X)\,min(Y\,479-Y))/70\,0\,1)'[vm];
color=c=white:s=480x480:r=30[wh];[wh][vm]overlay=format=auto,format=rgba[vw];
[bg]split[bgA][bgB];[bgA]crop=480:480:720:30[bgc];[bgc][vw]blend=all_mode=multiply,format=rgba[mul];
[bgB][mul]overlay=720:30[b0];[b0][2:v]overlay=0:0[b1];"
i=0; dir=1
while read r W; do
  if [ $dir = 1 ]; then X="t*${W}/${D}"; else X="${W}-t*${W}/${D}"; fi
  F+="[$((3+i)):v]format=rgba,crop=w=${CW}:h=96:x='${X}':y=7[s${i}];"
  i=$((i+1)); dir=$((1-dir))
done < layers/widths.txt
F+="[s0][s1][s2][s3]vstack=4,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(X/240\,0\,1)*clip((${CW}-X)/240\,0\,1)'[rows];
[b1][rows]overlay=0:628,format=yuv420p[out]"
OUT=canvas-$V-linkedin
ffmpeg -v error -y -loop 1 -framerate 30 -t $D -i layers/bg.png -stream_loop 3 -i canvas-icon-linkedin.mp4 -loop 1 -framerate 30 -t $D -i layers/head.png \
  $(for r in r1 r2 r3 r4; do echo -loop 1 -framerate 30 -t $D -i layers/$r.png; done) \
  -filter_complex "$F" -map "[out]" -t $D -r 30 -c:v libx264 -pix_fmt yuv420p -crf 17 -preset slow -movflags +faststart $OUT.mp4
ffmpeg -v error -y -ss 5 -i $OUT.mp4 -frames:v 1 $OUT.png
echo "$PWD/$OUT.mp4"
