#!/usr/bin/env node
/**
 * Seedream 5.5 图片生成脚本
 * 使用 seedream-5-5 模型（Nange AI 网关，/gpt-image/v1 异步接口）
 * 支持：文生图、图生图（最多 10 张参考图）、透明背景、图层拆分（含文字 OCR）。
 * 提交生成任务 → 轮询任务状态 → 下载文件到本地
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Seedream 使用专用分组的 Key，与 images2/25/26 的 Key 不同，所以使用独立的环境变量和配置文件，
// 不读取 NANGE_API_KEY / GPT_IMAGE_API_KEY / config.json，避免误用 GPT-Image 分组的 Key。
const CONFIG_PATH = path.join(os.homedir(), '.nange-ai', 'seedream.json');
const BASE_URL = (process.env.GPT_IMAGE_BASE_URL || 'https://api.nange-ai.com/gpt-image/v1').replace(/\/+$/, '');
const MODEL = 'seedream-5-5';

// 档位：1K / 1.5K 为低档，2K 为高档
const VALID_TIERS = ['1K', '1.5K', '2K'];
const VALID_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9', '2:1', '1:2'];
const VALID_BACKGROUNDS = ['auto', 'transparent', 'opaque'];
const VALID_OUTPUT_FORMATS = ['png', 'jpeg'];
const MAX_REFERENCE_IMAGES = 10;
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
const MIN_EXACT_PIXELS = 921600;
const MAX_EXACT_PIXELS = 4624220;
const LOW_TIER_MAX_PIXELS = 2610000;

const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const LAYER_POLL_TIMEOUT_MS = 20 * 60 * 1000;

const fail = (msg) => { console.error(`错误：${msg}`); process.exit(1); };

/**
 * 读取 API Key（优先级：环境变量 > 配置文件）
 */
function loadApiKey() {
  const envKey = process.env.SEEDREAM_API_KEY;
  if (envKey && envKey.trim()) {
    return envKey.trim();
  }

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (config.api_key && config.api_key !== 'YOUR_KEY' && config.api_key.trim()) {
        return config.api_key.trim();
      }
    } catch (_) { /* ignore parse errors */ }
  }

  console.error('错误：未找到 Seedream 专用 API Key');
  console.error('');
  console.error('Seedream 使用专用分组，需要单独的 Key（不能使用 images2 / images25 / images26 的 Key）。');
  console.error('请选择以下任一方式配置：');
  console.error('');
  console.error('  方式 A（环境变量）：');
  console.error('    export SEEDREAM_API_KEY="your-seedream-api-key"');
  console.error('');
  console.error('  方式 B（配置文件 seedream.json）：');
  if (process.platform === 'win32') {
    console.error(`    mkdir "%USERPROFILE%\\.nange-ai" && echo {"api_key":"YOUR_KEY"} > "%USERPROFILE%\\.nange-ai\\seedream.json"`);
  } else {
    console.error(`    mkdir -p ~/.nange-ai && echo '{"api_key":"YOUR_KEY"}' > ~/.nange-ai/seedream.json`);
  }
  console.error('');
  console.error('API Key 创建地址：https://api.nange-ai.com/keys（选择 Seedream 专用分组）');
  process.exit(1);
}

function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          reject(new Error(`无法解析响应: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif',
};

/**
 * 参数阶段的快速校验（dry-run 也会执行），不读取文件内容。
 */
function validateImageArg(arg) {
  if (!arg) fail('--image-url 缺少参数');
  if (arg.startsWith('data:')) return;
  if (arg.startsWith('http://')) fail(`参考图链接必须是 https：${arg}`);
  if (arg.startsWith('https://')) {
    if (/\.(avif|jp2)(\?|#|$)/i.test(arg)) {
      fail(`不支持 AVIF / JP2 参考图，请先转成 JPEG / PNG / WebP：${arg}`);
    }
    return;
  }
  const ext = path.extname(arg).toLowerCase();
  if (!MIME_TYPES[ext]) {
    fail(`不支持的参考图格式 "${ext}"，支持 JPEG / PNG / WebP / BMP / TIFF / GIF / HEIC / HEIF（不支持 AVIF、JP2）→ ${arg}`);
  }
}

function resolveImageArg(arg) {
  if (arg.startsWith('data:')) return arg;
  if (arg.startsWith('http://')) {
    fail(`参考图链接必须是 https：${arg}`);
  }
  if (arg.startsWith('https://')) {
    if (/\.(avif|jp2)(\?|#|$)/i.test(arg)) {
      fail(`不支持 AVIF / JP2 参考图，请先转成 JPEG / PNG / WebP：${arg}`);
    }
    return arg;
  }
  const absPath = path.resolve(arg);
  if (!fs.existsSync(absPath)) {
    fail(`图片文件不存在 → ${absPath}`);
  }
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) {
    fail(`不支持的参考图格式 "${ext}"，支持 JPEG / PNG / WebP / BMP / TIFF / GIF / HEIC / HEIF（不支持 AVIF、JP2）→ ${absPath}`);
  }
  const buf = fs.readFileSync(absPath);
  if (buf.length > MAX_REFERENCE_BYTES) {
    fail(`参考图超过 30 MiB 限制 → ${absPath}`);
  }
  process.stderr.write(`已读取本地图片: ${absPath} (${mime})\n`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        return;
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * 按档位估算单张输出价格档（仅用于提示，实际以任务结果的逐张像素为准）。
 */
function estimateTier(opts) {
  if (opts.layers) {
    const effective = opts.size || 'auto';
    return effective === '1K' || effective === '1.5K' ? '低档(1K/1.5K)' : '高档(2K)';
  }
  if (opts.pixels) {
    return opts.pixels.w * opts.pixels.h <= LOW_TIER_MAX_PIXELS ? '低档(1K/1.5K)' : '高档(2K)';
  }
  const tier = opts.ratio ? (opts.resolution || '2K') : (opts.size || '2K');
  return tier === '1K' || tier === '1.5K' ? '低档(1K/1.5K)' : '高档(2K)';
}

/**
 * 构造请求体。导出给 --dry-run 使用，便于在不调用接口的情况下检查参数。
 */
function buildRequestBody(opts) {
  const body = { model: MODEL, n: 1 };
  if (opts.prompt) body.prompt = opts.prompt;

  if (opts.layers) {
    body.layer_decomposition = true;
    const options = {};
    if (opts.maxLayers !== undefined) options.max_images = opts.maxLayers;
    if (opts.ocr) options.text_recognition = true;
    if (Object.keys(options).length > 0) body.layer_decomposition_options = options;
    if (opts.size) body.size = opts.size;
  } else if (opts.ratio) {
    body.size = opts.ratio;
    body.resolution = opts.resolution || '2K';
  } else if (opts.pixels) {
    body.size = `${opts.pixels.w}x${opts.pixels.h}`;
  } else {
    body.size = opts.size || '2K';
  }

  if (opts.outputFormat) body.output_format = opts.outputFormat;
  if (opts.background) body.background = opts.background;
  if (opts.watermark) body.watermark = true;
  if (opts.imageUrls && opts.imageUrls.length > 0) {
    body.image_urls = opts.imageUrls;
  }
  return body;
}

async function submitTask(apiKey, body) {
  const result = await request(`${BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  }, JSON.stringify(body));

  // 兼容 data 为数组 / 单个任务对象两种提交响应
  const data = result.data;
  const first = Array.isArray(data) ? data[0] : data;
  const taskId = first && (first.task_id || first.id);
  if (!taskId) {
    throw new Error(`提交响应中没有 task_id: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return taskId;
}

/**
 * 取任务对象：有 {code, data} 外壳时读 data，否则响应本身就是任务对象。
 */
function unwrapTask(result) {
  if (result && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    return result.data;
  }
  return result;
}

async function pollTask(apiKey, taskId, timeoutMs) {
  const start = Date.now();

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(`任务超时（超过 ${timeoutMs / 60000} 分钟），任务 ID: ${taskId}，可稍后继续查询，请勿重复提交`);
    }

    const result = await request(`${BASE_URL}/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const task = unwrapTask(result);
    const { status, progress, error } = task;

    if (status === 'completed') {
      const image = task.result && task.result.images && task.result.images[0];
      const urls = image ? (Array.isArray(image.url) ? image.url : [image.url]).filter(Boolean) : [];
      if (urls.length === 0) throw new Error('任务已完成但响应中没有图片链接');
      return { image, urls };
    }
    if (status === 'failed') {
      throw new Error((error && error.message) || '任务失败');
    }

    process.stderr.write(`生成中... ${progress || 0}%\n`);
    // 前 30 秒每 3 秒查询一次，之后每 6 秒
    await new Promise((r) => setTimeout(r, elapsed < 30000 ? 3000 : 6000));
  }
}

function printUsage() {
  console.error('用法: node generate.js --prompt "提示词" [选项]');
  console.error('');
  console.error('选项:');
  console.error('  --size <tier|WxH>        档位或精确像素 (默认: 2K；图层拆分默认 auto)');
  console.error('                           档位: 1K, 1.5K, 2K, auto；精确像素如 2048x1152（总像素 921600–4624220）');
  console.error('  --ratio <ratio>          比例 (可选)，和 --size 档位配合使用，如 --ratio 16:9 --size 1.5K');
  console.error('                           可选: ' + VALID_RATIOS.join(', '));
  console.error('  --background <bg>        背景 (可选): auto, transparent, opaque；transparent 必须 png；图层拆分不能用');
  console.error('  --output-format <fmt>    输出格式 (默认: png)  可选: png, jpeg');
  console.error('  --watermark              添加水印 (默认不加)');
  console.error('  --image-url <path|url>   参考图 (可多次指定, 最多 10 张, 每张 ≤ 30MB；https URL / data URI / 本地文件)');
  console.error('  --layers                 图层拆分：把输入图拆成底图 + 透明图层（必须恰好 1 张 --image-url，--prompt 可省略）');
  console.error('  --max-layers <n>         图层拆分输出总数上限 2-100 (默认 30，含底图)');
  console.error('  --ocr                    图层拆分时请求文字图层 OCR');
  console.error('  --out <path>             输出路径 (默认: ./output.<格式>；图层拆分时为目录，默认 ./seedream-layers)');
  console.error('  --dry-run                只打印请求体，不调用接口');
}

function parseArgs(argv) {
  const parsed = { imageUrls: [] };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--prompt': parsed.prompt = argv[++i]; break;
      case '--size': parsed.size = argv[++i]; break;
      case '--ratio': parsed.ratio = argv[++i]; break;
      case '--background': parsed.background = argv[++i]; break;
      case '--output-format': parsed.outputFormat = argv[++i]; break;
      case '--watermark': parsed.watermark = true; break;
      case '--image-url': parsed.imageUrls.push(argv[++i]); break;
      case '--layers': parsed.layers = true; break;
      case '--max-layers': parsed.maxLayers = argv[++i]; break;
      case '--ocr': parsed.ocr = true; break;
      case '--out': parsed.out = argv[++i]; break;
      case '--dry-run': parsed.dryRun = true; break;
      default:
        console.error(`错误：未知参数 "${argv[i]}"`);
        printUsage();
        process.exit(1);
    }
  }

  if (!parsed.layers && !parsed.prompt) {
    printUsage();
    process.exit(1);
  }
  if (parsed.layers === undefined) parsed.layers = false;

  // 枚举值不区分大小写
  for (const key of ['size', 'ratio', 'background', 'outputFormat']) {
    if (typeof parsed[key] === 'string') parsed[key] = parsed[key].trim().toLowerCase();
  }
  if (parsed.outputFormat === 'jpg') parsed.outputFormat = 'jpeg';
  if (!parsed.outputFormat) parsed.outputFormat = 'png';

  // 档位规范化：1k -> 1K, 1.5k -> 1.5K, 2k -> 2K
  const tierOf = (v) => VALID_TIERS.find((t) => t.toLowerCase() === v);

  if (parsed.size) {
    const pixelMatch = parsed.size.match(/^(\d+)x(\d+)$/);
    if (parsed.size === 'auto') {
      // 保持 auto
    } else if (tierOf(parsed.size)) {
      parsed.size = tierOf(parsed.size);
    } else if (pixelMatch) {
      const w = Number(pixelMatch[1]);
      const h = Number(pixelMatch[2]);
      const total = w * h;
      if (!(w > 0 && h > 0) || total < MIN_EXACT_PIXELS || total > MAX_EXACT_PIXELS) {
        fail(`精确像素 ${parsed.size} 的总像素必须在 ${MIN_EXACT_PIXELS}–${MAX_EXACT_PIXELS} 之间`);
      }
      if (w > h * 16 || h > w * 16) {
        fail(`精确像素 ${parsed.size} 的宽高比必须在 1/16–16 之间`);
      }
      parsed.pixels = { w, h };
    } else {
      fail(`不支持的 size "${parsed.size}"，可选: 1K, 1.5K, 2K, auto，或精确像素如 2048x1152（不支持 3K / 4K）`);
    }
  }

  if (parsed.ratio) {
    if (!VALID_RATIOS.includes(parsed.ratio)) {
      fail(`不支持的比例 "${parsed.ratio}"，可选: ${VALID_RATIOS.join(', ')}`);
    }
    if (parsed.pixels) fail('--ratio 不能和精确像素 --size 同时使用');
    if (parsed.size === 'auto') fail('--ratio 不能和 --size auto 同时使用，请指定档位 1K / 1.5K / 2K');
    parsed.resolution = parsed.size || '2K';
  }

  if (!VALID_OUTPUT_FORMATS.includes(parsed.outputFormat)) {
    fail(`不支持的输出格式 "${parsed.outputFormat}"，可选: png, jpeg`);
  }
  if (parsed.background && !VALID_BACKGROUNDS.includes(parsed.background)) {
    fail(`不支持的背景 "${parsed.background}"，可选: ${VALID_BACKGROUNDS.join(', ')}`);
  }
  if (parsed.background === 'transparent' && parsed.outputFormat === 'jpeg') {
    fail('透明背景必须输出 png，不能和 --output-format jpeg 同用');
  }

  if (parsed.maxLayers !== undefined) {
    const n = Number(parsed.maxLayers);
    if (!Number.isInteger(n) || n < 2 || n > 100) fail('--max-layers 必须是 2–100 的整数');
    parsed.maxLayers = n;
  }
  if ((parsed.maxLayers !== undefined || parsed.ocr) && !parsed.layers) {
    fail('--max-layers / --ocr 仅能用于 --layers 图层拆分模式');
  }

  if (parsed.layers) {
    if (parsed.imageUrls.length !== 1) fail('图层拆分必须恰好传 1 张 --image-url');
    if (parsed.ratio || parsed.pixels) fail('图层拆分的 --size 只支持 1K / 1.5K / 2K / auto，不能用比例或精确像素');
    if (parsed.background) fail('图层拆分不能传 --background（包括 auto）');
  }
  parsed.imageUrls.forEach(validateImageArg);
  if (parsed.imageUrls.length > MAX_REFERENCE_IMAGES) {
    fail(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`);
  }

  if (!parsed.out) {
    parsed.out = parsed.layers
      ? './seedream-layers'
      : `./output.${parsed.outputFormat === 'jpeg' ? 'jpg' : parsed.outputFormat}`;
  }
  return parsed;
}

function safeName(value) {
  return String(value || '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function extensionFor(url, format, fallback) {
  const fmt = (format || '').toLowerCase();
  if (fmt) return fmt === 'jpeg' ? 'jpg' : fmt;
  try {
    const ext = path.extname(new URL(url).pathname).replace('.', '').toLowerCase();
    if (ext) return ext;
  } catch (_) { /* ignore */ }
  return fallback;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.dryRun) {
    // 不读取本地文件内容，避免在 dry-run 时输出巨大的 base64
    const preview = { ...opts, imageUrls: opts.imageUrls.map((u) => (u.startsWith('http') || u.startsWith('data:') ? u : `<local:${u}>`)) };
    console.log(JSON.stringify(buildRequestBody(preview), null, 2));
    return;
  }

  const apiKey = loadApiKey();
  opts.imageUrls = opts.imageUrls.map(resolveImageArg);

  const mode = opts.layers ? '图层拆分' : (opts.imageUrls.length > 0 ? '图生图' : '文生图');
  const body = buildRequestBody(opts);
  process.stderr.write(`正在提交${mode}任务: model=${MODEL}, size=${body.size || '(默认 auto)'}${body.resolution ? `, resolution=${body.resolution}` : ''}, format=${opts.outputFormat}, 输出档位估算=${estimateTier(opts)}\n`);
  if (opts.imageUrls.length > 0) {
    process.stderr.write(`输入图片: ${opts.imageUrls.length} 张（每张输入图单独计费）\n`);
  }
  if (opts.layers) {
    process.stderr.write(`图层拆分按实际输出张数计费（底图和每个图层各算一张），上限 ${opts.maxLayers || 30} 张，请确认余额充足\n`);
  }

  const taskId = await submitTask(apiKey, body);
  process.stderr.write(`任务已提交: ${taskId}\n`);

  const { image, urls } = await pollTask(apiKey, taskId, opts.layers ? LAYER_POLL_TIMEOUT_MS : POLL_TIMEOUT_MS);

  if (!opts.layers) {
    const outPath = path.resolve(opts.out);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    process.stderr.write(`正在下载到 ${outPath} ...\n`);
    await downloadFile(urls[0], outPath);
    process.stderr.write('下载完成\n');
    console.log(outPath);
    return;
  }

  // 图层拆分：url[0] 是底图，其后是图层；元数据数组按下标对应，均为可选字段
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (let i = 0; i < urls.length; i++) {
    const layerMeta = Array.isArray(image.layers) ? image.layers[i] : undefined;
    const format = (Array.isArray(image.output_formats) && image.output_formats[i]) || (layerMeta && layerMeta.output_format);
    const ext = extensionFor(urls[i], format, i === 0 ? (opts.outputFormat === 'jpeg' ? 'jpg' : 'png') : 'png');
    const label = i === 0 ? 'base' : (safeName(layerMeta && layerMeta.name) || 'layer');
    const file = path.join(outDir, `${String(i).padStart(2, '0')}-${label}.${ext}`);
    process.stderr.write(`正在下载 (${i + 1}/${urls.length}) ${file} ...\n`);
    await downloadFile(urls[i], file);
    files.push(file);
  }

  // 保存图层元数据（尺寸、叠放顺序、bounding_box、OCR 等），便于后续合成
  const meta = { ...image };
  delete meta.url;
  meta.files = files.map((f) => path.basename(f));
  fs.writeFileSync(path.join(outDir, 'layers.json'), JSON.stringify(meta, null, 2));

  process.stderr.write(`下载完成，共 ${files.length} 张（含底图），元数据: ${path.join(outDir, 'layers.json')}\n`);
  console.log(outDir);
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  process.exit(1);
});
