/**
 * 文档 PDF 导出：复用页面布局视图的分页结果，交无头浏览器落盘
 *
 * 分页必须由浏览器实测高度决定（doc-layout.js 在做），服务端无法估算，
 * 因此这里拼一个自分页的打印页，把同一份 doc-layout.js 内联进去执行，
 * 再用 Chromium 的 --print-to-pdf 输出——打印页和编辑器里看到的分页是同一套代码算出来的。
 *
 * Chromium 不随包分发（2 核 2G 服务器装不下），沿用 LibreOffice 的做法：
 * 探测到就用，探测不到由调用方给出「改用浏览器打印」的中文提示。
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const PDF_TIMEOUT_MS = Number(process.env.PDF_TIMEOUT_MS || 90000);
const MAX_PDF_PAGES = Number(process.env.PDF_MAX_PAGES || 300);
/** 给无头浏览器留够排版时间（图片解码 + 分页测量都在这个预算内跑完） */
const LAYOUT_BUDGET_MS = Number(process.env.PDF_LAYOUT_BUDGET_MS || 20000);

const PT_TO_MM = 25.4 / 72;

// probePromise：undefined=尚未探测，解析为 null=已探测但未安装
let probePromise = null;
// 同一时刻只跑一个浏览器实例，避免小服务器被并发 PDF 打满内存
let running = null;

/** 布局脚本源码缓存：打印页必须内联同一份分页算法，不能各写一套 */
let layoutPromise = null;

function candidatePaths() {
  const list = [];
  if (process.env.CHROMIUM_PATH) list.push(process.env.CHROMIUM_PATH);
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (!root) continue;
      list.push(
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    }
  } else {
    list.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable');
  }
  return list;
}

async function canAccess(p) {
  try {
    await fs.access(p);
    return true;
  } catch (e) {
    return false;
  }
}

/** PATH 中查找可执行文件（Linux/macOS 用 which，Windows 用 where） */
async function lookupInPath(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execAsync(`${finder} ${name}`, { windowsHide: true });
    const first = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    return first && await canAccess(first) ? first : null;
  } catch (e) {
    return null;
  }
}

/**
 * 探测无头浏览器（结果缓存，进程内只探测一次）
 */
function probe() {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    // 顺序探测候选路径（数量很少，且命中即止，不需要并发）
    for (const p of candidatePaths()) {
      // eslint-disable-next-line no-await-in-loop
      if (p && await canAccess(p)) return p;
    }
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'microsoft-edge']) {
      // eslint-disable-next-line no-await-in-loop
      const hit = await lookupInPath(name);
      if (hit) return hit;
    }
    return null;
  })();
  probePromise.catch(() => { /* 探测失败按未安装处理 */ });
  return probePromise;
}

/** 是否具备服务端生成 PDF 的能力 */
async function isAvailable() {
  return Boolean(await probe());
}

function toFileUrl(p) {
  const slashed = path.resolve(p).replace(/\\/g, '/');
  return 'file:///' + (/^[A-Za-z]:/.test(slashed) ? slashed : slashed.replace(/^\//, ''));
}

/** pt → mm，用于 @page 尺寸，保证 PDF 页面盒子与 .dl-page 完全等大 */
function ptToMm(pt) {
  return Math.round(pt * PT_TO_MM * 100) / 100;
}

async function loadLayoutScript() {
  let publicDir;
  try { publicDir = require('../config/app-root').publicDir; } catch (e) { /* ignore */ }
  if (!publicDir) publicDir = path.join(__dirname, '..', '..', 'public');
  const file = path.join(publicDir, 'js', 'doc-layout.js');
  // 发布即重启进程，一次读入常驻内存即可，避免每次导出都碰磁盘
  return fs.readFile(file, 'utf8');
}

function readLayoutScript() {
  if (!layoutPromise) {
    layoutPromise = loadLayoutScript().catch(e => {
      layoutPromise = null; // 读取失败不缓存，下次导出再试
      throw e;
    });
  }
  return layoutPromise;
}

function escAttr(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** JSON 安全嵌入 <script>：避免内容里的 </script> 提前闭合标签 */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
}

/**
 * 拼出自分页的打印页：分页逻辑与编辑器页面视图同源
 * @param {object} flow renderDocFlow 的返回值
 * @param {object} [opts] { title, from, to, headerFooter }
 * @returns {Promise<string>} HTML
 */
async function buildPrintPage(flow, opts) {
  const o = opts || {};
  const sec0 = (flow.sections && flow.sections[0]) || {};
  const pageW = Number(sec0.pageWidthPt) || 595;
  const pageH = Number(sec0.pageHeightPt) || 842;
  const layoutSrc = await readLayoutScript();
  const data = { css: flow.css, sections: flow.sections, warnings: flow.warnings || [] };
  const range = { from: Number(o.from) || 1, to: Number(o.to) || 0, headerFooter: o.headerFooter !== false };

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>' + escAttr(o.title || '文档') + '</title>'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: https: http:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">'
    + '<style>' + flow.css + '</style>'
    // 打印页不需要标尺与屏显留白，直接按 @page 尺寸铺满
    + '<style>@page{size:' + ptToMm(pageW) + 'mm ' + ptToMm(pageH) + 'mm;margin:0}'
    + 'html,body{margin:0;padding:0;background:#fff;}</style>'
    + '</head><body class="dl-print-root">'
    + '<div class="dl-sheet" id="dlSheet"></div>'
    + '<div class="dl-measure" id="dlMeasure"></div>'
    + '<script>' + layoutSrc + '</script>'
    // doc-layout.js 会自行补齐 .dl-* 样式，保证与编辑器页面视图用同一份测量规则
    + '<script>window.__PDF_RESULT=DocLayout.renderPrintPage(document,'
    + jsonForScript(data) + ',' + jsonForScript(range) + ');</script>'
    + '</body></html>';
}

function browserArgs(bin, htmlFile, pdfFile, profileDir) {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const args = [
    `--user-data-dir=${profileDir}`,
    '--headless',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    // 分页测量与图片解码都在虚拟时间内跑完，避免打印时拿到半成品
    `--virtual-time-budget=${LAYOUT_BUDGET_MS}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfFile}`,
    toFileUrl(htmlFile),
  ];
  // 服务器上常以 root 运行，Chromium 只有显式允许才能起沙箱外的进程
  if (asRoot || bin.indexOf('edge') >= 0) args.splice(2, 0, '--no-sandbox');
  return args;
}

/** 无头浏览器退出但没写出 PDF 时给出的原始报错，够定位又不泄露路径 */
function runError(stderr) {
  const tail = String(stderr || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
  return tail.slice(0, 200);
}

/**
 * 生成 PDF
 * @param {object} flow renderDocFlow 的返回值
 * @param {object} [opts] { title, from, to, headerFooter }
 * @returns {Promise<Buffer>}
 */
async function toPdf(flow, opts) {
  // 占用判断与登记之间不能有 await，否则两个请求会同时通过检查、各起一个浏览器
  if (running) {
    throw Object.assign(new Error('服务器正在生成其他 PDF，请稍后重试'), { code: 'BUSY' });
  }
  const job = (async () => {
    const bin = await probe();
    if (!bin) throw Object.assign(new Error('服务器未安装 Chromium，无法生成 PDF'), { code: 'NO_BROWSER' });

    const sections = (flow && flow.sections) || [];
    if (!sections.length) throw Object.assign(new Error('文档没有可打印的内容'), { code: 'EMPTY' });
    const totalBlocks = sections.reduce((n, s) => n + ((s.blocks || []).length), 0);
    if (totalBlocks > MAX_PDF_PAGES * 40) {
      throw Object.assign(new Error('文档过大，请分段导出 PDF'), { code: 'TOO_LARGE' });
    }

    const html = await buildPrintPage(flow, opts);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-pdf-'));
    const htmlFile = path.join(dir, 'print.html');
    const pdfFile = path.join(dir, 'out.pdf');
    try {
      await fs.writeFile(htmlFile, html, 'utf8');
      await new Promise((resolve, reject) => {
        execFile(bin, browserArgs(bin, htmlFile, pdfFile, path.join(dir, 'profile')),
          { timeout: PDF_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => err ? reject(Object.assign(err, { stderr })) : resolve());
      });
      const pdf = await fs.readFile(pdfFile);
      if (!pdf.length || pdf.slice(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('浏览器未输出有效的 PDF 文件');
      }
      return pdf;
    } catch (e) {
      if (e.code === 'EMPTY' || e.code === 'TOO_LARGE' || e.code === 'NO_BROWSER') throw e;
      const detail = runError(e.stderr);
      throw Object.assign(new Error(detail ? `PDF 生成失败：${detail}` : 'PDF 生成失败'), { code: 'RUN_FAILED' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  running = job;
  try {
    return await job;
  } finally {
    if (running === job) running = null;
  }
}

module.exports = { isAvailable, toPdf, buildPrintPage, ptToMm };
