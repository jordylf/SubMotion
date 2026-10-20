# Third-party software

## Bundled in the release package

| Component | Use in SubMotion | License | Source |
|---|---|---|---|
| whisper.cpp `b5454` (`whisper-cli.exe`, `whisper.dll`, `ggml*.dll`, in `bin/win/`) | Local speech-to-text, run as a separate process | MIT, full text in `bin/win/whisper.cpp-LICENSE.txt` | https://github.com/ggml-org/whisper.cpp/releases/tag/b5454 |

whisper.cpp needs the Microsoft Visual C++ 2015-2022 (x64) runtime, which is usually present on
machines with Adobe apps installed. If it is missing, SubMotion asks the user to install it.

## Downloaded on first use (not redistributed by SubMotion)

When transcription is used for the first time, the panel asks and then downloads these from their
publishers into `%APPDATA%\SubMotion`:

| Component | License | Source |
|---|---|---|
| FFmpeg 9.0, LGPL build by BtbN (`ffmpeg.exe`, plus its license as `ffmpeg-LICENSE.txt`) | LGPL v3 (`--enable-version3`), with the licenses of its statically linked libraries | https://github.com/BtbN/FFmpeg-Builds (FFmpeg source: https://ffmpeg.org/download.html) |
| Whisper large-v3-turbo model, ggml format (`ggml-large-v3-turbo-q5_0.bin`, SHA-256 checked) | MIT (OpenAI Whisper) | https://huggingface.co/ggerganov/whisper.cpp |
| Silero VAD model, ggml format (`ggml-silero-v6.2.0.bin`, SHA-256 checked) | MIT | https://huggingface.co/ggml-org/whisper-vad |

SubMotion runs FFmpeg as a separate program; users can point SubMotion at any other `ffmpeg.exe`
under *Transcription setup*.
