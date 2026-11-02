/**
 * LibreOffice 无头模式：旧版二进制 Office 格式（.doc/.ppt）的唯一可行转换途径
 *
 * .doc/.ppt 是 OLE 复合二进制格式，Node 生态没有可靠的纯 JS 解析器，
 * 因此检测到 soffice 时先转成 .docx/.pptx 再走 office-import.js 的解析器；
 * 未安装时由调用方抛出「请另存为新格式」的提示，不让导入流程整体不可用。
 *
 * 全程异步：候选路径探测与临时文件读写都走 fs/promises，
 * 避免在 2 核小服务器上阻塞事件循环（转换的临时文件可达上百 MB）。
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const CONVERT_TIMEOUT_MS = Number(process.env.LIBREOFFICE_TIMEOUT_MS || 120000);

// binPath：undefined=尚未探测，null=已探测但未安装
let binPath;
let probePromise = null;

/** 常见安装位置（不同发行版/Windows 路径差异较大，逐个探测） */
function candidatePaths() {
  const list = [];
  if (process.env.LIBREOFFICE_PATH) list.push(process.env.LIBREOFFICE_PATH);
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (root) list.push(path.join(root, 'LibreOffice', 'program', 'soffice.exe'));
    }
  } else {
    list.push('/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice');
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
 * 探测 soffice（结果缓存，进程内只探测一次；导入 .doc/.ppt 时惰性触发）
 */
function probe() {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    // 顺序探测候选路径（数量很少，且命中即止，不需要并发）
    for (const p of candidatePaths()) {
      // eslint-disable-next-line no-await-in-loop
      if (p && await canAccess(p)) { binPath = p; return p; }
    }
    binPath = await lookupInPath('soffice') || await lookupInPath('libreoffice');
    return binPath;
  })();
  probePromise.catch(() => { /* 探测失败按未安装处理 */ });
  return probePromise;
}

/** Windows 下 soffice 的 UserInstallation 需要 file:// URL */
function toFileUrl(p) {
  const slashed = path.resolve(p).replace(/\\/g, '/');
  return 'file:///' + (/^[A-Za-z]:/.test(slashed) ? slashed : slashed.replace(/^\//, ''));
}

/**
 * 转换单个文件
 * @param {Buffer} buffer 原始文件内容
 * @param {string} fromExt 源扩展名（不含点，如 doc）
 * @param {string} toExt 目标扩展名（不含点，如 docx）
 * @returns {Promise<Buffer>} 转换后的文件内容
 */
async function convert(buffer, fromExt, toExt) {
  const bin = await probe();
  if (!bin) throw new Error(`未安装 LibreOffice，无法转换 .${fromExt} 文件`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-import-'));
  const src = path.join(dir, 'source.' + fromExt);
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await fs.writeFile(src, buffer);
    const args = [
      // 独立 profile 目录：避免与桌面端实例争用默认配置，也允许并发转换
      `-env:UserInstallation=${toFileUrl(path.join(dir, 'profile'))}`,
      '--headless', '--norestore', '--invisible', '--nodefault',
      '--convert-to', toExt, '--outdir', dir, src
    ];
    await new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve());
    });
    const out = path.join(dir, 'source.' + toExt);
    const converted = await fs.readFile(out);
    if (!converted.length) throw new Error('转换结果为空');
    await cleanup();
    return converted;
  } catch (err) {
    await cleanup();
    const detail = String((err && (err.stderr || err.stdout)) || (err && err.message) || '').split(/\r?\n/).filter(Boolean).pop() || '';
    throw new Error(`.${fromExt} 转换 .${toExt} 失败${detail ? '：' + detail.slice(0, 200) : ''}`);
  }
}

/** office-import.js 的 convertLegacy 适配器 */
function convertLegacyAdapter(fromExt, buffer, filename) {
  const target = fromExt === 'doc' ? 'docx' : 'pptx';
  return convert(buffer, fromExt, target).catch((e) => {
    throw new Error(`${filename || '.' + fromExt}：${e.message}`);
  });
}

/** 测试用：重置探测缓存 */
function resetCache() {
  binPath = undefined;
  probePromise = null;
}

module.exports = { probe, convert, convertLegacyAdapter, resetCache, CONVERT_TIMEOUT_MS };
