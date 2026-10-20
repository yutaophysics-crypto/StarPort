# Read subtitles with your signed-in Edge browser

English | [Chinese](zh-CN/browser-video-subtitles.md)

The shared video reader currently supports Bilibili subtitles for all four adapters. It uses the connected browser's login; it does not require another model login.

## Connect once

1. In Edge, sign in to Bilibili. Open `edge://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select `extensions/edge` in this StarPort checkout. Reload the extension after updating an existing installation.
3. Refresh StarPort. Open **+ → Attach Microsoft Edge → Connect Edge**, then copy the pairing code.
4. Open the StarPort extension, paste the code and allow Bilibili access. Other-site access is optional and must be enabled explicitly.

## Read a video

Choose **+ → Read video subtitles**, enter a video URL or BV identifier and select **Read and attach**. Open the resulting attachment to preview its contents.

You can also put a video URL or BV identifier directly in a message. StarPort reads the subtitles first, then sends the message and attachment to the chosen tool. For multipart videos, include the part number, for example `https://www.bilibili.com/video/BV1XLbr65EZ4/?p=2`.

Missing subtitles, authentication failures, network errors and excessive length leave the draft intact and explain what happened. A video description is not substituted for subtitles. Platform subtitles can omit visual information or contain transcription errors. This feature neither downloads the video nor transcribes its audio.

## Data boundaries

Cookies, account tokens and signed subtitle-download URLs remain in Edge. StarPort stores the requested video URL, title, language, timestamps and subtitle text. The attachment enters the selected conversation's shared context and follows normal attachment retention rules.

Only explicitly requested videos are read. The reader reuses a matching video tab or temporarily opens one in the same browser profile and closes only that temporary tab afterwards.

## Local diagnostic

`node scripts/check-video-browser.mjs` reports the connection state. Adding a URL or BV identifier actually reads that video and creates a previewable subtitle attachment; it does not invoke a model or send a chat message. Diagnostic output contains connection status and subtitle counts, not browser credentials.
