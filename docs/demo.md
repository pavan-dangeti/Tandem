# Tandem demo video

`demo.mp4` is a two-minute, 1080p H.264 version of the recorded browser
demo in `demo.gif`. It repeats that 23.91-second sequence five times, with no
claim that the passes are separate sessions. The sequence shows two browser
replicas editing a board, one replica working offline, and convergence after
it reconnects.

The source GIF is committed so the video can be regenerated locally without
external services:

```sh
ffmpeg -stream_loop -1 -i docs/demo.gif -t 120 -vf "fps=30,scale=1920:-2:flags=lanczos,format=yuv420p" -c:v libx264 -crf 22 -movflags +faststart -an docs/demo.mp4
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 docs/demo.mp4
```

The expected duration is exactly 120 seconds. The video contains no audio;
the GIF remains the compact preview used in the README.
