const express = require('express');
const router = express.Router();
const { logActivity } = require('../../config/activity');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');
const { removeDir, copyDirCrossPlatform } = require('../../utils/fs-helpers');
const { formatBytes } = require('../../utils/format');

const isWindows = process.platform === 'win32';

// GitHub repo config（固定地址，不可修改）
const GITHUB_OWNER = 'wgg223';
const GITHUB_REPO = 'wangzhan';

// 允许的下载地址主机（GitHub zipball 相关域名）
const ALLOWED_DOWNLOAD_HOSTS = ['api.github.com', 'codeload.github.com', 'github.com'];

// 更新后保留的自动备份数量
const BACKUP_KEEP_COUNT = 3;

// ============ 更新任务状态（进程内存，单实例） ============
let updateTask = null; // { status, version, progress, message, error, backupPath, startedAt }

const RUNNING_STATUSES = ['downloading', 'extracting', 'backing_up', 'installing'];

function isTaskRunning() {
  return Boolean(updateTask) && RUNNING_STATUSES.includes(updateTask.status);
}

function setTask(patch) {
  if (updateTask) Object.assign(updateTask, patch);
}

function failTask(message) {
  if (!updateTask) return;
  updateTask.status = 'error';
  updateTask.message = message;
  updateTask.error = message;
  // 1分钟后自动清除，允许重新发起更新
  setTimeout(() => { if (updateTask && updateTask.status === 'error') updateTask = null; }, 60000);
}

function completeTask(message) {
  if (!updateTask) return;
  updateTask.status = 'done';
  updateTask.progress = 100;
  updateTask.message = message;
  updateTask.error = null;
  setTimeout(() => { if (updateTask && updateTask.status === 'done') updateTask = null; }, 60000);
}

// 校验下载地址：仅允许 GitHub 官方 zipball 域名且路径属于本仓库
function isValidDownloadUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.includes(parsed.hostname)) return false;
  const p = parsed.pathname;
  return p.includes('/wgg223/wangzhan/') || p.includes('/repos/wgg223/wangzhan/');
}

// 版本号比较：返回 1(a>b)、0(a=b)、-1(a<b)
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function readCurrentVersion(projectRoot) {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0';
    }
  } catch (e) { /* ignore */ }
  return '0.0.0';
}

// 从 GitHub API 获取 Release 列表，返回按版本号降序排列的 release 数组
async function fetchReleases() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const releasesUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`;
    const res = await fetch(releasesUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Website-Update-Checker'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error('GitHub API 返回状态码 ' + res.status);
    const releases = await res.json();
    return releases
      .map(r => ({ release: r, version: (r.tag_name || '').replace(/^v/, '') }))
      .filter(x => /^\d+(\.\d+)*$/.test(x.version))
      .sort((a, b) => compareVersions(b.version, a.version));
  } finally {
    clearTimeout(timeoutId);
  }
}

function unzipCrossPlatform(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    if (isWindows) {
      exec(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, (error) => {
        if (error) reject(new Error('PowerShell解压失败: ' + error.message));
        else resolve();
      });
    } else {
      exec(`unzip -o "${zipPath}" -d "${destDir}"`, (error) => {
        if (error) reject(new Error('unzip解压失败: ' + error.message));
        else resolve();
      });
    }
  });
}

/**
 * 扫描解压目录，检测 zip-slip 路径穿越（用于系统 unzip 回退分支的事后校验）。
 * 递归遍历所有文件/目录，若相对路径包含 .. 或解析后超出 rootDir，则记录为违规。
 * @returns {string[]} 违规路径列表（空数组表示安全）
 */
function scanForZipSlip(rootDir) {
  const violations = [];
  const rootResolved = path.resolve(rootDir);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootResolved, fullPath);
      // 路径穿越检测：相对路径含 .. 或解析后超出 root
      if (relPath.includes('..') || path.isAbsolute(relPath)) {
        violations.push(relPath);
        continue;
      }
      const resolved = path.resolve(rootResolved, relPath);
      if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
        violations.push(relPath);
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
      }
    }
  }
  walk(rootDir);
  return violations;
}

// 下载文件并上报进度（0-55 区间映射下载阶段）
function downloadWithProgress(url, zipPath) {
  return new Promise((resolve, reject) => {
    const downloadFile = (u) => {
      if (!isValidDownloadUrl(u)) {
        reject(new Error('下载地址非法（非 GitHub 官方源）'));
        return;
      }
      const protocol = u.startsWith('https') ? https : http;
      const request = protocol.get(u, {
        headers: {
          'User-Agent': 'Website-Updater',
          'Accept': 'application/zip, application/octet-stream, */*'
        }
      }, (response) => {
        // 处理重定向
        const REDIRECT_CODES = [301, 302, 307, 308];
        if (REDIRECT_CODES.includes(response.statusCode)) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            reject(new Error('重定向地址缺失'));
            return;
          }
          downloadFile(new URL(redirectUrl, u).toString());
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`下载失败，状态码: ${response.statusCode}`));
          return;
        }

        const contentLength = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        const file = fs.createWriteStream(zipPath);
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (contentLength > 0) {
            const pct = Math.min(54, Math.round((downloadedBytes / contentLength) * 54));
            setTask({ progress: pct, message: `正在下载更新包 ${formatBytes(downloadedBytes)} / ${formatBytes(contentLength)}` });
          }
        });
        response.pipe(file);

        file.on('finish', () => {
          file.close();
          if (contentLength > 0 && downloadedBytes !== contentLength) {
            const errMsg = `下载不完整: 期望=${contentLength}B, 实际=${downloadedBytes}B`;
            try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
            reject(new Error(errMsg));
            return;
          }
          if (downloadedBytes === 0) {
            const errMsg = '下载失败: 文件大小为0';
            try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
            reject(new Error(errMsg));
            return;
          }
          setTask({ progress: 55, message: '下载完成，准备解压' });
          resolve();
        });

        file.on('error', (err) => {
          fs.unlink(zipPath, () => {});
          reject(err);
        });
      });

      request.on('error', (err) => {
        reject(err);
      });

      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error('下载超时'));
      });
    };

    downloadFile(url);
  });
}

// 判断依赖是否变化（package.json 对比），决定是否需要 npm install
function needsNpmInstall(oldPkgPath, projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) return true;
  try {
    const oldPkg = JSON.parse(fs.readFileSync(oldPkgPath, 'utf8'));
    const newPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return JSON.stringify(oldPkg.dependencies || {}) !== JSON.stringify(newPkg.dependencies || {});
  } catch (e) {
    return true;
  }
}

// 清理多余的自动备份，只保留最近 N 份
function pruneOldBackups(projectRoot, keep) {
  try {
    const dirs = fs.readdirSync(projectRoot)
      .filter(f => /^backup_\d+$/.test(f))
      .map(f => {
        const p = path.join(projectRoot, f);
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch (e) { /* ignore */ }
        return { name: f, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const d of dirs.slice(keep)) {
      console.log('[system-update] 清理旧备份:', d.name);
      removeDir(path.join(projectRoot, d.name));
    }
  } catch (e) {
    console.warn('[system-update] 清理旧备份失败:', e.message);
  }
}

// 从备份恢复项目文件（回滚）
async function rollbackFromBackup(projectRoot, backupDir) {
  const items = ['package.json', 'server', 'views', 'public'];
  for (const item of items) {
    const srcPath = path.join(backupDir, item);
    const destPath = path.join(projectRoot, item);
    if (!fs.existsSync(srcPath)) continue;
    try {
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        await copyDirCrossPlatform(srcPath, destPath);
      } else {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(srcPath, destPath);
      }
      console.log(`[system-update] 回滚 ${item} 成功`);
    } catch (err) {
      console.warn(`[system-update] 回滚 ${item} 失败:`, err.message);
    }
  }
}

// 重启服务器：优先按 PM2 应用名精准重启，回退到重启全部，再回退到直接启动
function doRestart(projectRoot, delayMs) {
  setTimeout(() => {
    console.log('[system-update] 更新完成，正在重启服务器...');

    // 直接拉起新进程兜底（拉起后当前进程退出，由新进程接管端口）
    const spawnAndExit = () => {
      console.log('[system-update] 使用 npm run start 重启...');
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(npmCmd, ['run', 'start'], {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        shell: process.platform === 'win32'
      });
      child.unref();
      process.exit(0);
    };

    if (process.env.PM2_HOME || process.env.pm_id) {
      // PM2 环境：依次尝试多种重启命令（pm2 可能不在子进程 PATH 中），全部失败才退回直接拉起
      const attempts = [
        'pm2 restart website-admin',
        'pm2 restart all',
        'npx --no-install pm2 restart website-admin'
      ];
      const tryNext = (i) => {
        if (i >= attempts.length) {
          console.error('[system-update] PM2 重启全部失败，回退到直接启动（PM2 autorestart 会自动拉起）');
          spawnAndExit();
          return;
        }
        exec(attempts[i], (error, stdout, stderr) => {
          if (!error) {
            console.log('[system-update] 重启命令执行成功:', attempts[i]);
            return;
          }
          console.error(`[system-update] ${attempts[i]} 失败:`, error.message, (stderr || '').trim());
          tryNext(i + 1);
        });
      };
      tryNext(0);
    } else {
      spawnAndExit();
    }
  }, delayMs);
}

// ============ 后台更新任务 ============
async function runUpdateTask(projectRoot, db, actor) {
  let tempDir = path.join(projectRoot, 'temp_update');
  let backupDir = null;
  let projectModified = false;

  try {
    // 1. 获取最新 Release（服务端决定目标版本，不信任客户端）
    setTask({ message: '正在获取最新版本信息...' });
    const releases = await fetchReleases();
    const latest = releases[0];
    if (!latest || !latest.release) {
      throw new Error('无法获取 GitHub Release 信息，请检查网络连接或稍后重试');
    }

    const version = latest.version;
    setTask({ version });
    const zipballUrl = latest.release.zipball_url || '';
    if (!isValidDownloadUrl(zipballUrl)) {
      throw new Error('获取的下载地址无效');
    }

    // 2. 禁止降级
    const currentVersion = readCurrentVersion(projectRoot);
    if (compareVersions(version, currentVersion) < 0) {
      throw new Error(`不允许降级：目标版本 v${version} 低于当前版本 v${currentVersion}`);
    }

    // 3. 下载更新包
    setTask({ status: 'downloading', progress: 1, message: '开始下载更新包...' });
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const zipPath = path.join(tempDir, 'update.zip');
    await downloadWithProgress(zipballUrl, zipPath);

    // 4. 解压
    setTask({ status: 'extracting', progress: 55, message: '正在解压更新包...' });
    const zipFileSize = fs.statSync(zipPath).size;
    if (zipFileSize < 100) {
      throw new Error('下载的文件过小(' + zipFileSize + ' bytes)，可能不是有效的更新包');
    }

    let zipRejected = false;
    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      // 防 zip-slip 路径穿越
      const badEntry = entries.find(e => e.entryName.includes('..'));
      if (badEntry) {
        zipRejected = true;
        throw new Error('更新包包含非法路径: ' + badEntry.entryName);
      }
      zip.extractAllTo(tempDir, true);
      console.log('[system-update] adm-zip解压完成，共', entries.length, '个条目');
    } catch (zipError) {
      // 校验类失败不回退到系统 unzip（避免绕过 zip-slip 防护）
      if (zipRejected) throw zipError;
      console.error('[system-update] adm-zip解压失败:', zipError.message);
      try {
        await unzipCrossPlatform(zipPath, tempDir);
        console.log('[system-update] 系统unzip解压完成');
        // 系统 unzip 回退分支：解压后扫描全部文件，校验无路径穿越（zip-slip）
        const slipFiles = scanForZipSlip(tempDir);
        if (slipFiles.length > 0) {
          await removeDir(tempDir);
          throw new Error('更新包包含非法路径(zip-slip): ' + slipFiles.slice(0, 3).join(', '));
        }
      } catch (unzipError) {
        throw new Error('所有解压方法都失败: ' + zipError.message);
      }
    }

    const extractedFiles = fs.readdirSync(tempDir).filter(f => f !== 'update.zip');
    if (extractedFiles.length === 0) {
      throw new Error('解压后目录为空，更新包可能已损坏');
    }

    let sourceDir;
    const extractedDir = extractedFiles.find(f => {
      const fullPath = path.join(tempDir, f);
      return fs.statSync(fullPath).isDirectory();
    });

    if (extractedDir) {
      sourceDir = path.join(tempDir, extractedDir);
    } else {
      sourceDir = tempDir;
    }

    // 4.1 更新包完整性校验：验证关键文件存在且版本号匹配（GitHub zipball 无 checksum，此为基础防篡改）
    const pkgJsonPath = path.join(sourceDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      throw new Error('更新包缺少 package.json，可能已损坏或被篡改');
    }
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (!pkgJson.version || !/^\d+\.\d+\.\d+/.test(pkgJson.version)) {
        throw new Error('更新包 package.json 版本号无效: ' + (pkgJson.version || 'undefined'));
      }
      if (pkgJson.version !== version) {
        throw new Error(`更新包版本不匹配：期望 v${version}，实际 v${pkgJson.version}`);
      }
    } catch (parseErr) {
      throw new Error('更新包 package.json 解析失败: ' + parseErr.message);
    }
    if (!fs.existsSync(path.join(sourceDir, 'server'))) {
      throw new Error('更新包缺少 server/ 目录，可能已损坏或被篡改');
    }

    // 5. 备份当前项目
    setTask({ status: 'backing_up', progress: 70, message: '正在备份当前项目...' });
    backupDir = path.join(projectRoot, 'backup_' + Date.now());
    fs.mkdirSync(backupDir, { recursive: true });

    const backupFiles = ['package.json', 'server', 'public', 'views'];
    for (const item of backupFiles) {
      const sourcePath = path.join(projectRoot, item);
      const destPath = path.join(backupDir, item);
      if (fs.existsSync(sourcePath)) {
        try {
          const stat = fs.statSync(sourcePath);
          if (stat.isDirectory()) {
            await copyDirCrossPlatform(sourcePath, destPath);
          } else {
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }
            fs.copyFileSync(sourcePath, destPath);
          }
          console.log(`[system-update] 备份 ${item} 成功`);
        } catch (err) {
          console.warn(`[system-update] 备份 ${item} 失败:`, err.message);
        }
      }
    }

    // 6. 复制更新文件到项目目录
    setTask({ status: 'installing', progress: 78, message: '正在安装更新文件...' });

    // 预清理历史嵌套目录（cp -r 旧版语义错误在历史更新中可能残留 server/server 等垃圾目录）
    for (const d of ['server', 'views', 'public']) {
      const nested = path.join(projectRoot, d, d);
      if (fs.existsSync(nested)) {
        console.warn(`[system-update] 更新前清理历史嵌套目录: ${nested}`);
        await removeDir(nested);
      }
    }

    const updateItems = fs.readdirSync(sourceDir);
    for (const item of updateItems) {
      const sourcePath = path.join(sourceDir, item);
      const destPath = path.join(projectRoot, item);

      if (item === 'node_modules' || item === '.git' || item === 'temp_update') {
        continue;
      }

      try {
        const stat = fs.statSync(sourcePath);
        if (stat.isDirectory()) {
          const ok = await copyDirCrossPlatform(sourcePath, destPath);
          if (!ok) throw new Error('复制目录失败');
        } else {
          const destDir = path.dirname(destPath);
          if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
          }
          fs.copyFileSync(sourcePath, destPath);
        }
        console.log(`[system-update] 复制 ${item} 成功`);
      } catch (err) {
        // 复制失败必须中止安装并回滚，不能静默跳过（否则会出现新 package.json + 旧代码的脏状态）
        console.error(`[system-update] 复制 ${item} 失败:`, err.message);
        throw new Error(`更新文件复制失败（${item}）: ${err.message}`);
      }
    }
    projectModified = true;

    // 6.1 校验复制结果：检测 cp -r 语义错误导致的嵌套目录（server/server 等），存在即视为安装失败
    for (const d of ['server', 'views', 'public']) {
      if (fs.existsSync(path.join(projectRoot, d, d))) {
        throw new Error(`更新文件复制异常：检测到 ${d}/${d} 嵌套目录（复制逻辑错误），已触发回滚`);
      }
    }

    // 7. 安装依赖（依赖未变化时跳过，加速更新）
    if (needsNpmInstall(path.join(backupDir, 'package.json'), projectRoot)) {
      setTask({ progress: 85, message: '正在安装依赖 (npm install)...' });
      console.log('[system-update] 开始执行 npm install...');
      await new Promise((resolve, reject) => {
        exec('npm install --production --ignore-scripts', { cwd: projectRoot, timeout: 180000 }, (error, stdout, stderr) => {
          if (error) {
            console.error('[system-update] npm install 失败:', error.message);
            reject(new Error('npm install 失败: ' + error.message));
          } else {
            console.log('[system-update] npm install 完成');
            resolve();
          }
        });
      });
    } else {
      console.log('[system-update] 依赖未变化，跳过 npm install');
      setTask({ progress: 95, message: '依赖未变化，跳过 npm install' });
    }

    // 8. 清理临时目录
    await removeDir(tempDir);
    tempDir = null;

    // 9. 清理旧备份，只保留最近 N 份
    pruneOldBackups(projectRoot, BACKUP_KEEP_COUNT);

    // 10. 记录更新完成
    try {
      logActivity(db, {
        user_id: actor.user_id,
        username: actor.username,
        action: 'complete_update',
        target_type: 'system',
        target_title: '系统更新',
        detail: `${actor.username} 完成系统更新，版本 v${version}（备份: ${path.basename(backupDir)}）`,
        ip: actor.ip
      });
    } catch (logErr) {
      console.error('[system-update] logActivity 错误:', logErr.message);
    }

    console.log('[system-update] 更新完成，备份目录:', backupDir);
    completeTask(`更新安装成功！已更新到 v${version}，服务器将在3秒后自动重启`);
    doRestart(projectRoot, 3000);
  } catch (err) {
    console.error('[system-update] 更新失败:', err);

    // 项目文件已被覆盖且存在备份时自动回滚
    if (projectModified && backupDir && fs.existsSync(backupDir)) {
      try {
        setTask({ message: '安装失败，正在从备份回滚...' });
        await rollbackFromBackup(projectRoot, backupDir);
      } catch (rollbackErr) {
        console.error('[system-update] 回滚失败:', rollbackErr.message);
      }
    }

    if (tempDir && fs.existsSync(tempDir)) {
      await removeDir(tempDir);
    }

    failTask('更新失败: ' + err.message);
  }
}

// ============ 路由 ============

// GET - 系统更新页面
router.get('/', (req, res) => {
  res.render('admin/system-update', {
    user: req.session.user,
    userPermissions: res.locals.userPermissions || []
  });
});

// POST - 检查GitHub更新
router.post('/check', async (req, res) => {
  try {
    const projectRoot = require('../../config/app-root').projectRoot;
    const currentVersion = readCurrentVersion(projectRoot);

    let releases = [];
    try {
      releases = await fetchReleases();
    } catch (e) {
      if (e.name === 'AbortError') {
        return res.status(502).json({ success: false, error: '请求超时，无法连接到 GitHub' });
      }
      throw e;
    }

    const latest = releases[0];
    if (!latest) {
      return res.status(502).json({
        success: false, error: '无法获取 GitHub Release 信息，请检查网络连接或稍后重试'
      });
    }

    const latestVersion = latest.version;
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    const changelog = releases.map(r => ({
      version: r.version,
      name: r.release.name || '',
      body: r.release.body || '',
      publishedAt: r.release.published_at || '',
      isCurrent: r.version === currentVersion
    }));

    try {
      const db = req.db;
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'check_update',
        target_type: 'system',
        target_title: '系统更新',
        detail: `用户 ${req.session.user.username} 检查了系统更新`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[system-update] logActivity 错误:', logErr.message);
    }

    res.json({
      success: true,
      data: {
        hasUpdate: hasUpdate,
        currentVersion: currentVersion,
        latestVersion: latestVersion,
        releaseName: latest.release.name || '',
        releaseBody: latest.release.body || '',
        releaseUrl: latest.release.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
        publishedAt: latest.release.published_at || '',
        downloadUrl: latest.release.zipball_url || '',
        changelog: changelog
      }
    });
  } catch (err) {
    console.error('[Admin] 检查更新失败:', err);
    res.status(500).json({ success: false, error: '检查更新失败: ' + err.message });
  }
});

// POST - 启动更新任务（后台异步执行，服务端自行获取最新版本）
router.post('/download', async (req, res) => {
  try {
    if (isTaskRunning()) {
      return res.status(409).json({ success: false, error: '已有更新任务正在进行，请稍后再试' });
    }

    const projectRoot = require('../../config/app-root').projectRoot;
    const currentVersion = readCurrentVersion(projectRoot);

    updateTask = {
      status: 'downloading',
      version: '',
      progress: 0,
      message: '正在启动更新任务...',
      error: null,
      backupPath: null,
      startedAt: Date.now()
    };

    try {
      const db = req.db;
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'start_update',
        target_type: 'system',
        target_title: '系统更新',
        detail: `用户 ${req.session.user.username} 开始系统更新（当前版本 v${currentVersion}）`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[system-update] logActivity 错误:', logErr.message);
    }

    res.json({ success: true, message: '更新任务已启动，正在后台下载并安装...' });

    // 后台执行（不阻塞响应），携带操作者信息用于完成日志
    runUpdateTask(projectRoot, req.db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      ip: req.ip
    });
  } catch (err) {
    console.error('[Admin] 启动更新失败:', err);
    if (updateTask) {
      updateTask.status = 'error';
      updateTask.error = err.message;
    }
    res.status(500).json({ success: false, error: '启动更新失败: ' + err.message });
  }
});

// GET - 获取更新任务进度
router.get('/progress', (req, res) => {
  if (!updateTask) {
    return res.json({ success: true, data: { status: 'idle' } });
  }
  res.json({
    success: true,
    data: {
      status: updateTask.status,
      version: updateTask.version || '',
      progress: updateTask.progress || 0,
      message: updateTask.message || '',
      error: updateTask.error || '',
      backupPath: updateTask.backupPath || '',
      startedAt: updateTask.startedAt
    }
  });
});

// POST - 重启服务器
router.post('/restart', (req, res) => {
  try {
    const projectRoot = require('../../config/app-root').projectRoot;
    try {
      const db = req.db;
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'restart_server',
        target_type: 'system',
        target_title: '系统重启',
        detail: `用户 ${req.session.user.username} 重启了服务器`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[system-update] logActivity 错误:', logErr.message);
    }

    res.json({
      success: true,
      message: '服务器将在3秒后重启...'
    });

    doRestart(projectRoot, 3000);
  } catch (err) {
    console.error('[Admin] 重启服务器失败:', err);
    res.status(500).json({ success: false, error: '重启服务器失败: ' + err.message });
  }
});

// GET - 获取更新状态
router.get('/status', (req, res) => {
  const projectRoot = require('../../config/app-root').projectRoot;
  const currentVersion = readCurrentVersion(projectRoot);

  res.json({
    success: true,
    data: {
      currentVersion: currentVersion,
      nodeVersion: process.version,
      platform: process.platform,
      uptime: process.uptime()
    }
  });
});

module.exports = router;
