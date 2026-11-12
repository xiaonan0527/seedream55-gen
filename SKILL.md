---
name: seedream-55
description: 使用 Nange AI Seedream 5.5 API 生成图片，支持文生图、图生图（最多 10 张参考图融合）、透明背景（贴纸/抠图）、图层拆分（把海报拆成底图 + 透明图层，可选文字 OCR），1K / 1.5K / 2K 三档分辨率或精确像素，按输出张数 + 参考图张数计费。当用户说"seedream"、"用 seedream 画"、"即梦"、"豆包生图"、"透明背景"、"贴纸"、"抠图"、"图层拆分"、"拆图层"、"把海报拆成图层"、"多图融合"、"参考这几张图"、"生图"、"画图"、"生成图片"、"帮我画"、"把这张图改成"等涉及 AI 图片生成、透明背景图、图层拆分或图片编辑的请求时触发此技能。首次使用会引导配置 API Key，后续直接生成。
---

# Seedream 5.5 图片生成

通过 Nange AI 的 Seedream 5.5 API（模型 `seedream-5-5`）生成图片。异步任务模式：提交 → 轮询 → 下载到本地。支持：

- **文生图 / 图生图**：最多 10 张参考图，可做多图融合、风格迁移、局部编辑
- **透明背景**：`--background transparent` 直接输出透明 PNG（贴纸、图标、商品抠图）
- **图层拆分**：把一张图（海报、设计稿）拆成底图 + 多个透明图层，可选文字 OCR
- **分辨率**：`1K` / `1.5K` / `2K` 档位、档位 + 比例、或精确像素

## ⚠️ Seedream 5.5 的限制与计费（必须遵守）

| 项目 | 限制 |
|---|---|
| 分辨率 | 只有 `1K` / `1.5K` / `2K`（默认 2K）；**不支持 3K / 4K**，要 4K 请改用 `gpt-image-2.6-ext`（images26-gen） |
| 张数 | 每次固定输出 1 张；图层拆分的数量用 `--max-layers` 控制 |
| 参考图 | 最多 10 张；https 公网链接 / data URI / 本地文件；JPEG PNG WebP BMP TIFF GIF HEIC HEIF，**不支持 AVIF、JP2**；单张 ≤ 30 MiB，总像素 ≤ 3600 万 |
| 透明背景 | 必须输出 `png`，不能和 `jpeg` 同用；图层拆分模式下不能传 `--background`（包括 auto） |
| 提示词优化 | 上游固定启用 standard，无法关闭 |
| 不支持 | `stream`、`tools`、组图（`n` 只能为 1） |
| 结果保存 | 图片链接仅保留一段时间，脚本会立即下载到本地 |

**计费（站内额度，$ 与站点余额 1:1）：**

| 项目 | 价格 |
|---|---|
| 输出图 1K / 1.5K（每张） | $0.13 |
| 输出图 2K（每张） | $0.2275 |
| 每张参考图（含图层拆分的输入图，没有首张免费） | $0.052 |

- 输出图按**每张实际总像素**分档：≤ 2,610,000 像素为 1K / 1.5K 档，超过为 2K 档
- 费用 = 输出图费用 + 参考图数量 × 0.052；提交时不扣费，只有成功出图才扣，失败不扣费
- **图层拆分按实际输出张数计费**（底图和每个图层各算一张）+ 1 张输入图。`--max-layers` 默认 30，2K 下最多约 $6.8，务必提醒用户确认余额，优先用较小的 `--max-layers` 和 `--size 1K`
- 示例：2K 出图 + 2 张参考图 = 0.2275 + 0.104 = **$0.3315**

默认 2K。用户只是试稿/草图时建议主动用 `--size 1K` 省钱；没有明确高清需求不要升到 2K。

## 前置检查

每次触发时按顺序检查：

### 1. 检查 Node.js

运行 `node -v`，如果失败则提示用户：

> 此技能需要 Node.js 环境，请先安装：https://nodejs.org/

### 2. 检查 API Key 配置

Seedream 使用**专用分组**，需要**单独的 Key**，与 images2 / images25 / images26 用的 GPT-Image 分组 Key 不是同一个。因此本 skill 使用**独立的**环境变量和配置文件，**不会读取** `NANGE_API_KEY` 和 `~/.nange-ai/config.json`（这些留给 images 系列 skill 使用，两边互不影响）。

优先读取环境变量 `SEEDREAM_API_KEY`，如果未设置则检查配置文件 `~/.nange-ai/seedream.json`。

如果都不存在，引导用户选择一种方式配置：

**方式 A：环境变量（推荐）**
```bash
export SEEDREAM_API_KEY="这里粘贴你的Seedream专用Key"
```

**方式 B：配置文件**

**macOS / Linux：**
```bash
mkdir -p ~/.nange-ai && echo '{"api_key":"这里粘贴你的Seedream专用Key"}' > ~/.nange-ai/seedream.json
```

**Windows (PowerShell)：**
```powershell
mkdir -Force "$env:USERPROFILE\.nange-ai" | Out-Null; '{"api_key":"这里粘贴你的Seedream专用Key"}' | Set-Content "$env:USERPROFILE\.nange-ai\seedream.json"
```

告知用户 API Key 在这里创建：https://api.nange-ai.com/keys （分组选择 **Seedream 专用分组**）

> ⚠️ 该分组的 Key 只能调用 `seedream-5-5`；GPT-Image 分组的 Key 不能调用 Seedream。如果脚本返回 403 `not configured for seedream-5-5`，说明 Key 的分组不对，请让用户检查 `SEEDREAM_API_KEY` / `seedream.json` 里是不是误填了 GPT-Image 分组的 Key。

用户配置完成后才继续生成流程。已配置过的用户直接跳到生成步骤。

---

## 🎯 提示词写法（Seedream 5.5）

Seedream 对**自然语言完整描述**响应很好，中英文均可。给用户写提示词时：

1. **主体 + 场景 + 风格 + 光线 + 构图**：按这个顺序写成连贯的句子，不要堆关键词
2. **补充具体细节**：材质、颜色、动作、镜头（特写/全景/俯拍）、光线（柔和侧光、黄昏逆光），不要只用 "beautiful"、"cinematic"
3. **文字渲染**：把需要出现的文字用引号括起来，并说明位置、字体风格；要求"不要额外文字"
4. **排除项**：明确写 "无水印、无多余文字、无 logo"
5. **图生图 / 多图融合**：为每张图编号并说明用途（"第一张图的商品"、"第二张图的场景"），说明要改什么、必须保持什么不变
6. **透明背景/贴纸**：提示词里写"主体居中、边缘干净、无背景、无阴影地面"，并配合 `--background transparent`
7. 提示词不需要刻意超长；简单物体 2-3 句，复杂场景 4-6 句，复杂编辑 6-10 句分段写

用户只给了简短需求时（如"画只猫"），主动补全主体、环境、风格、光线再提交；但不要擅自改变用户明确指定的内容。

---

## 生成流程

读取配置后调用脚本（`$SKILL_DIR` 为本 skill 所在目录）：

**文生图（默认 2K）：**
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "用户的提示词" \
  --out "./output.png"
```

**草图/省钱（1K）：**
```bash
node "$SKILL_DIR/scripts/generate.js" --prompt "..." --size 1K --out "./draft.png"
```

**指定比例（比例 + 档位）：**
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "星空下的古老城堡" \
  --ratio 16:9 --size 1.5K \
  --out "./castle.png"
```

**精确像素（总像素 921,600–4,624,220，不能再配比例）：**
```bash
node "$SKILL_DIR/scripts/generate.js" --prompt "..." --size 2048x1152 --out "./wide.png"
```

**透明背景贴纸 / 图标：**
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "一只橙色猫咪贴纸，白色描边，主体居中，边缘干净，无背景" \
  --size 1K --background transparent \
  --out "./cat-sticker.png"
```

**图生图 / 多图融合（本地文件或 https 链接，可重复传，最多 10 张）：**
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --prompt "把第一张图中的商品放进第二张图的场景里，保留商品的标志和包装文字，匹配场景光线" \
  --image-url "./product.png" \
  --image-url "https://example.com/scene.jpg" \
  --ratio 16:9 --size 1.5K \
  --out "./result.png"
```

**图层拆分（输出到目录，`--prompt` 可省略；必须恰好 1 张输入图）：**
```bash
node "$SKILL_DIR/scripts/generate.js" \
  --layers \
  --image-url "./poster.png" \
  --max-layers 10 --ocr \
  --size 1K \
  --out "./poster-layers"
```

图层拆分的结果是一个目录：`00-base.png` 是底图，其后 `01-xxx.png`、`02-xxx.png` … 是透明图层；`layers.json` 记录每层的尺寸、叠放顺序 `z_index`、`bounding_box`（底图坐标系）和可选的 OCR 文字。合成时按 `z_index` 从小到大叠放，图层要缩放到 `bounding_box` 的宽高后放到 `(left, top)`。图层拆分可能需要几分钟。

脚本自动完成：提交任务 → 轮询状态 → 下载文件到本地 → stdout 输出本地文件（或目录）的绝对路径。**超时后不要重复提交**，脚本会打印任务 ID 供继续查询（重复提交会重复扣费）。

想先检查参数是否正确，可加 `--dry-run` 只打印请求体而不调用接口。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--prompt` | （必填；图层拆分可省略） | 提示词 |
| `--size` | `2K`（图层拆分 `auto`） | `1K` / `1.5K` / `2K` / `auto`，或精确像素 `WxH` |
| `--ratio` | （无） | `1:1` `4:3` `3:4` `16:9` `9:16` `3:2` `2:3` `21:9` `2:1` `1:2`，和 `--size` 档位配合；不能和精确像素/`auto` 同用 |
| `--background` | （上游默认 auto） | `auto` / `transparent` / `opaque`；透明必须 png；图层拆分不能用 |
| `--output-format` | `png` | `png` / `jpeg`；图层拆分时只控制底图，图层恒为透明 PNG |
| `--watermark` | 关 | 添加水印 |
| `--image-url` | （无） | 参考图，可多次传，最多 10 张 |
| `--layers` | 关 | 图层拆分模式 |
| `--max-layers` | 30 | 图层拆分输出总数上限 2–100（含底图），仅 `--layers` 可用 |
| `--ocr` | 关 | 图层拆分时请求文字图层 OCR，仅 `--layers` 可用；传了 `--prompt` 可能导致 OCR 不返回 |
| `--out` | `./output.<格式>`（图层拆分 `./seedream-layers`） | 输出路径 / 目录 |
| `--dry-run` | — | 只打印请求体 |

### 场景 → 参数推荐表

| 场景 | 参数 |
|---|---|
| 试稿 / 快速看效果 | `--size 1K` |
| 海报 / 竖版封面 | `--ratio 2:3 --size 2K` |
| 横版配图 / 壁纸 | `--ratio 16:9 --size 2K` |
| 手机壁纸 | `--ratio 9:16 --size 2K` |
| 贴纸 / 图标 / 商品抠图 | `--background transparent --size 1K`（png） |
| 多图融合 / 换背景 | `--image-url` × N，比例跟随场景图 |
| 把设计稿/海报拆图层 | `--layers --max-layers 10 --size 1K`（需要文字再加 `--ocr`） |

### 常见错误

| 现象 | 处理 |
|---|---|
| 403 `not configured for seedream-5-5` | Key 所在分组不是 Seedream 专用分组，让用户创建 Seedream 分组的 Key |
| 403 `only supports seedream-5-5` | 反过来：Seedream 分组的 Key 不能用于别的模型 |
| 400 `resolution must be ...` / `invalid size` | 只支持 1K / 1.5K / 2K，不支持 3K / 4K；脚本会提前拦截 |
| 400 `layer_decomposition requires exactly 1 image` | 图层拆分必须恰好 1 张 `--image-url` |
| 400 `unsupported data URI image type` | 参考图格式不支持（AVIF / JP2），先转成 JPEG / PNG / WebP |
| 任务 `failed` | 常见原因：参考图链接无法访问、内容安全拦截。失败不扣费，调整后重新提交 |

## 结果检查清单

生成后检查并如实告知用户：

1. ✅ **主体与构图**是否符合描述
2. ✅ **文字**拼写是否正确（有文字渲染需求时）
3. ✅ **透明背景**是否真的透明（打开 PNG 确认棋盘格）
4. ✅ **编辑范围**是否只改了要求的部分
5. ✅ **图层拆分**：图层数量、文字层是否被拆出；OCR 只对规整文字层可能返回，不能保证每层都有

## 输出

脚本成功后将文件下载到 `--out` 指定的本地路径，stdout 输出本地文件（图层拆分为目录）的绝对路径。将该路径展示给用户即可，并简要说明本次大约花费（按上面的价格表估算）。
