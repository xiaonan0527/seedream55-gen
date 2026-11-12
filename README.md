# Seedream 5.5 Skill

A skill for AI coding agents (Claude Code, Codex, etc.) that enables Seedream 5.5 (`seedream-5-5`) image generation via the Nange AI API.

- Text-to-image and image-to-image (up to **10 reference images**, multi-image fusion)
- **Transparent background** output (stickers, icons, cut-outs)
- **Layer decomposition**: split one image into a base image + transparent layers, with optional text OCR
- Resolutions: `1K` / `1.5K` / `2K` tiers, tier + aspect ratio, or exact pixel sizes

## Limitations (read this first)

| Item | Limit |
|---|---|
| Resolution | `1K` / `1.5K` / `2K` only (default 2K). **No 3K / 4K** — use [images26-gen](https://github.com/xiaonan0527/images26-gen) for 4K |
| Images per request | Exactly 1 (layer decomposition output count is controlled by `--max-layers`) |
| Reference images | Up to 10; https URL / data URI / local file; JPEG PNG WebP BMP TIFF GIF HEIC HEIF (**no AVIF / JP2**); ≤ 30 MiB each, ≤ 36M total pixels |
| Transparent background | PNG only, cannot be combined with JPEG; not allowed in layer decomposition mode (even `auto`) |
| API key group | Needs a key from the dedicated **Seedream** group; GPT-Image group keys cannot call Seedream and vice versa |

## Pricing (site balance, $ 1:1)

| Item | Price |
|---|---|
| Output image 1K / 1.5K (each) | $0.13 |
| Output image 2K (each) | $0.2275 |
| Each reference / input image (no free first image) | $0.052 |

Each output image is tiered by its **actual total pixels** (≤ 2,610,000 px is the 1K / 1.5K tier, above is the 2K tier). Layer decomposition is billed by the **actual number of outputs** (base + every layer) plus 1 input image. Nothing is charged at submit time and failed tasks are not charged.

## Installation

Send this to your AI agent:

```
帮我安装 https://github.com/xiaonan0527/seedream55-gen/blob/main/README.md 这个 skill，并生成一张图片
```

Or manually clone:

```bash
git clone https://github.com/xiaonan0527/seedream55-gen.git seedream-55
```

## Setup Instructions (for the agent)

### Step 1: Check Node.js

Run `node -v`. If it fails, tell the user to install Node.js from https://nodejs.org/.

### Step 2: Check API Key

Seedream uses a **dedicated group with its own API key** — it is NOT the same key as images2 / images25 / images26. This skill therefore reads its own variable/file and does **not** read `NANGE_API_KEY` or `~/.nange-ai/config.json`, so both sets of skills can coexist.

**Option A: Environment variable (recommended)**
```bash
export SEEDREAM_API_KEY="your-seedream-api-key"
```

**Option B: Config file** `~/.nange-ai/seedream.json`

macOS / Linux:
```bash
mkdir -p ~/.nange-ai && echo '{"api_key":"PASTE_YOUR_SEEDREAM_KEY_HERE"}' > ~/.nange-ai/seedream.json
```

Windows PowerShell:
```powershell
mkdir -Force "$env:USERPROFILE\.nange-ai" | Out-Null; '{"api_key":"PASTE_YOUR_SEEDREAM_KEY_HERE"}' | Set-Content "$env:USERPROFILE\.nange-ai\seedream.json"
```

API Key creation: https://api.nange-ai.com/keys (choose the **Seedream** group)

### Step 3: Generate

```bash
node "<skill-dir>/scripts/generate.js" --prompt "the user's prompt" --size 1K --out ./output.png
```

The script submits an async task, polls until completion, downloads the result and prints the absolute path to stdout (a directory for layer decomposition). Progress goes to stderr. If it times out, do **not** resubmit — the script prints the task ID.

## Trigger phrases

- "seedream" / "用 seedream 画" / "即梦" / "生图" / "画图" / "帮我画"
- "透明背景" / "贴纸" / "抠图"
- "图层拆分" / "拆图层" / "把海报拆成图层"
- "多图融合" / "参考这几张图" / "把这张图改成"
- "generate an image" / "create a picture"

## Parameters

| Param | Default | Description |
|---|---|---|
| `--prompt` | (required; optional for `--layers`) | Prompt |
| `--size` | `2K` (`auto` for layers) | `1K`, `1.5K`, `2K`, `auto`, or exact pixels `WxH` (921,600–4,624,220 total pixels) |
| `--ratio` | (none) | `1:1` `4:3` `3:4` `16:9` `9:16` `3:2` `2:3` `21:9` `2:1` `1:2`; combine with a tier `--size` |
| `--background` | (upstream `auto`) | `auto`, `transparent`, `opaque` |
| `--output-format` | `png` | `png` or `jpeg` (layer decomposition: base image only) |
| `--watermark` | off | Add watermark |
| `--image-url` | (none) | Reference image, repeatable (max 10) |
| `--layers` | off | Layer decomposition mode (exactly 1 `--image-url`) |
| `--max-layers` | 30 | Layer decomposition output cap 2–100 (includes base image) |
| `--ocr` | off | Request text OCR for text layers |
| `--out` | `./output.<fmt>` (`./seedream-layers` for layers) | Output file / directory |
| `--dry-run` | — | Print the request body and exit |

## Layer decomposition output

`--out` is a directory: `00-base.png` is the base image, `01-*.png`, `02-*.png`, ... are transparent layers, and `layers.json` stores each layer's size, `z_index`, `bounding_box` (in base-image coordinates) and optional OCR. Stack by ascending `z_index`; scale each layer to its `bounding_box` width/height and place it at `(left, top)`.

## Examples

```bash
# Transparent sticker
node scripts/generate.js --prompt "orange cat sticker, white outline, clean edges, no background" --size 1K --background transparent --out cat.png

# Multi-image fusion
node scripts/generate.js --prompt "Put the product from image 1 into the scene of image 2" --image-url ./product.png --image-url https://example.com/scene.jpg --ratio 16:9 --size 1.5K --out result.png

# Layer decomposition with OCR
node scripts/generate.js --layers --image-url ./poster.png --max-layers 10 --ocr --size 1K --out ./poster-layers
```
