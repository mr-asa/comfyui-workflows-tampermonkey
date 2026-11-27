# ComfyUI Workflows

A Tampermonkey userscript for websites, including Discord Web. It adds a **WF** badge for embedded ComfyUI workflows and a **P** badge for prompt-only files.

## Install

Open [Install in Tampermonkey](https://raw.githubusercontent.com/mr-asa/comfyui-workflows-tampermonkey/main/ComfyUIWorkflows.user.js), click **Install**, and reload the page you want to use it on.

Tampermonkey checks GitHub for updates. You can also run a manual update check from the Tampermonkey dashboard. To publish an update, increase the script's @version and push it to main.

YouTube, Netflix, Twitch, Disney+, Prime Video, Hulu, Max, and Spotify are excluded. The script skips HLS and DASH playlists and blob URLs. For other sites, you can add exclusions in Tampermonkey.

## Settings

Open **ComfyUI Workflow settings** from the Tampermonkey menu, or choose **Settings** from a badge. Changes apply to existing badges when saved.

Enter X and Y from 0 to 1. X increases rightward and Y increases downward, relative to the attachment or code block.

| X | Y | Position |
| --- | --- | --- |
| 0 | 0 | Top left |
| 1 | 0 | Top right |
| 0 | 1 | Bottom left |
| 1 | 1 | Bottom right |
| 0.5 | 0.5 | Center |

The default ComfyUI URL is `http://127.0.0.1:8188`. Use **Test connection** to check your URL. Tampermonkey may ask for permission to contact your configured server.

## Imagus

Hover over a thumbnail to open the Imagus or Imagus Reborn popup. The script checks the media URL shown in the popup and displays a badge if that file contains ComfyUI metadata.

## Badge actions

- View and copy positive and negative prompts.
- Queue API prompts in ComfyUI with model path matching and confirmation for quantization substitutions.
- Inspect model and LoRA availability and open model search links.
- Download workflow and prompt JSON. The browser controls the download folder. Settings can enable copying the suggested filename.

The script checks original attachments for PNG, WebP, JPEG, MP4, WebM, MOV, MKV, M4V, FLAC, MP3, OGG, OPUS, M4A, WAV, and JSON. It also detects workflow JSON pasted in code blocks. Large audio and video use byte ranges. Discord may strip workflow metadata from re-encoded files.

Ported from the [BetterDiscord plugin](https://github.com/mr-asa/comfyui_workflow). See [LICENSE](LICENSE).
