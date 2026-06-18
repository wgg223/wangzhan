const express = require('express');
const router = express.Router();
const { logActivity } = require('../../config/activity');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');

const isWindows = process.platform === 'win32';

// GitHub repo config
const GITHUB_REPOS = {
  main: { owner: process.env.GITHUB_OWNER || 'wgg223', repo: process.env.GITHUB_REPO || 'wangzhan' },
  rphub: { owner: 'STA1N156', repo: 'RP-Hub' }
};

function copyDirCrossPlatform(src, dest) {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(`robocopy "${src}" "${dest}" /E /NFL /NDL /NJH /NJS /nc /ns /np`, (error) => {
        resolve(error && error.code > 7 ? false : true);
      });
    } else {
      exec(`cp -r "${src}" "${dest}"`, (error) => {
        resolve(!error);
      });
    }
  });
}

function removeDirCrossPlatform(dir) {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(`rd /s /q "${dir}"`, () => resolve());
    } else {
      exec(`rm -rf "${dir}"`, () => resolve());
    }
  });
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

// 系统更新检查 - 需要 super_admin 权限

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
    const { owner: githubOwner, repo: githubRepo } = GITHUB_REPOS.main;
    const currentVersion = process.env.APP_VERSION || '1.6.1';
    
    const githubApiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;
    
    const response = await fetch(githubApiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'RP-Hub-Update-Checker'
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      return res.json({
        success: true,
        data: {
          hasUpdate: false,
          currentVersion: currentVersion,
          latestVersion: currentVersion,
          message: '无法连接到 GitHub，使用本地版本信息'
        }
      });
    }
    
    const releaseData = await response.json();
    const latestVersion = releaseData.tag_name?.replace(/^v/, '') || currentVersion;
    const hasUpdate = latestVersion !== currentVersion;
    
    // 记录检查更新操作
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
        releaseName: releaseData.name || '',
        releaseBody: releaseData.body || '',
        releaseUrl: releaseData.html_url || '',
        publishedAt: releaseData.published_at || '',
        downloadUrl: releaseData.zipball_url || ''
      }
    });
  } catch (err) {
    console.error('[Admin] 检查更新失败:', err);
    res.status(500).json({ success: false, error: '检查更新失败: ' + err.message });
  }
});

// POST - 下载并安装更新
router.post('/download', async (req, res) => {
  try {
    const { downloadUrl, version } = req.body;
    
    if (!downloadUrl) {
      return res.status(400).json({ success: false, error: '缺少下载链接' });
    }
    
    const projectRoot = path.resolve(__dirname, '../../..');
    const tempDir = path.join(projectRoot, 'temp_update');
    const backupDir = path.join(projectRoot, 'backup_' + Date.now());
    
    // 记录开始更新
    try {
      const db = req.db;
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'start_update',
        target_type: 'system',
        target_title: '系统更新',
        detail: `用户 ${req.session.user.username} 开始下载更新版本 ${version}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[system-update] logActivity 错误:', logErr.message);
    }
    
    // 创建临时目录
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // 下载文件
    const zipPath = path.join(tempDir, 'update.zip');
    
    console.log('[system-update] 开始下载文件:', downloadUrl);
    
    await new Promise((resolve, reject) => {
      const downloadFile = (url) => {
        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, {
          headers: {
            'User-Agent': 'RP-Hub-Updater',
            'Accept': 'application/zip, application/octet-stream, */*'
          }
        }, (response) => {
          console.log('[system-update] 下载响应状态码:', response.statusCode);
          console.log('[system-update] 响应头Content-Type:', response.headers['content-type']);
          
          // 处理重定向
          if (response.statusCode === 302 || response.statusCode === 301 || response.statusCode === 307) {
            const redirectUrl = response.headers.location;
            console.log('[system-update] 跟随重定向到:', redirectUrl);
            downloadFile(redirectUrl);
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
          });
          response.pipe(file);
          
          file.on('finish', () => {
            file.close();
            console.log('[system-update] 文件下载完成，大小:', downloadedBytes, 'bytes');

            // 验证下载完整性：如果有Content-Length头，检查下载大小是否匹配
            if (contentLength > 0 && downloadedBytes !== contentLength) {
              const errMsg = `下载不完整: 期望=${contentLength}B, 实际=${downloadedBytes}B`;
              console.error('[system-update]', errMsg);
              try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
              reject(new Error(errMsg));
              return;
            }

            // 验证下载的文件不为空
            if (downloadedBytes === 0) {
              const errMsg = '下载失败: 文件大小为0';
              console.error('[system-update]', errMsg);
              try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
              reject(new Error(errMsg));
              return;
            }

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
      
      downloadFile(downloadUrl);
    });
    
    // 解压前验证zip文件完整性
    const zipFileSize = fs.statSync(zipPath).size;
    console.log('[system-update] 开始解压文件:', zipPath);
    console.log('[system-update] zip文件大小:', zipFileSize, 'bytes');

    if (zipFileSize < 100) {
      throw new Error('下载的文件过小(' + zipFileSize + ' bytes)，可能不是有效的更新包');
    }
    
    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      console.log('[system-update] zip文件包含', entries.length, '个条目');
      
      if (entries.length > 0) {
        console.log('[system-update] 前5个条目:', entries.slice(0, 5).map(e => e.entryName));
      }
      
      zip.extractAllTo(tempDir, true);
      console.log('[system-update] adm-zip解压完成，共', entries.length, '个条目');

      // 验证解压后是否有实际内容
      const extractedFiles = fs.readdirSync(tempDir).filter(f => f !== 'update.zip');
      if (extractedFiles.length === 0) {
        throw new Error('解压后目录为空，更新包可能已损坏');
      }
    } catch (zipError) {
      console.error('[system-update] adm-zip解压失败:', zipError.message);
      try {
        await unzipCrossPlatform(zipPath, tempDir);
        console.log('[system-update] 系统unzip解压完成');
      } catch (unzipError) {
        throw new Error('所有解压方法都失败: adm-zip: ' + zipError.message + ', unzip: ' + unzipError.message);
      }
    }
    
    // 调试：列出解压后的文件
    console.log('[system-update] 解压后tempDir内容:', fs.readdirSync(tempDir));
    
    // 查找解压后的目录或文件
    const files = fs.readdirSync(tempDir).filter(f => f !== 'update.zip');
    
    let sourceDir;
    
    // 检查是否有子目录（GitHub zipball通常会有一个子目录）
    const extractedDir = files.find(f => {
      const fullPath = path.join(tempDir, f);
      return fs.statSync(fullPath).isDirectory();
    });
    
    if (extractedDir) {
      sourceDir = path.join(tempDir, extractedDir);
    } else if (files.length > 0) {
      // 如果没有子目录，直接使用tempDir作为源目录
      sourceDir = tempDir;
    } else {
      throw new Error('解压失败，未找到更新文件');
    }
    
    // 备份当前项目（排除node_modules, temp_update等）
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    // 复制关键文件进行备份
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
    
    // 复制更新文件到项目目录
    const updateItems = fs.readdirSync(sourceDir);
    for (const item of updateItems) {
      const sourcePath = path.join(sourceDir, item);
      const destPath = path.join(projectRoot, item);
      
      // 跳过node_modules和一些特殊目录
      if (item === 'node_modules' || item === '.git' || item === 'temp_update') {
        continue;
      }
      
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
        console.log(`[system-update] 复制 ${item} 成功`);
      } catch (err) {
        console.warn(`[system-update] 复制 ${item} 失败:`, err.message);
      }
    }
    
    // 清理临时文件
    await removeDirCrossPlatform(tempDir);
    
    // 记录更新完成
    try {
      const db = req.db;
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'complete_update',
        target_type: 'system',
        target_title: '系统更新',
        detail: `用户 ${req.session.user.username} 完成更新到版本 ${version}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[system-update] logActivity 错误:', logErr.message);
    }
    
    res.json({
      success: true,
      message: '更新下载并安装成功，建议重启服务器以应用更改',
      backupPath: backupDir
    });
    
  } catch (err) {
    console.error('[Admin] 下载更新失败:', err);
    res.status(500).json({ success: false, error: '下载更新失败: ' + err.message });
  }
});

// POST - 重启服务器
router.post('/restart', (req, res) => {
  try {
    const projectRoot = path.resolve(__dirname, '../../..');
    // 记录重启操作
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
    
    // 延迟3秒后重启
    setTimeout(() => {
      console.log('[系统更新] 正在重启服务器...');
      
      // 使用PM2重启（如果使用PM2）
      if (process.env.PM2_HOME || process.env.pm_id) {
        console.log('[系统更新] 检测到PM2，使用PM2重启...');
        exec('pm2 restart all', (error, stdout, stderr) => {
          if (error) {
            console.error('[系统更新] PM2重启失败:', error.message);
            console.log('[系统更新] 尝试使用npm run start重启...');
            // 回退到npm run start
            const child = spawn('npm', ['run', 'start'], {
              cwd: projectRoot,
              detached: true,
              stdio: 'ignore'
            });
            child.unref();
            process.exit(0);
          } else {
            console.log('[系统更新] PM2重启成功:', stdout);
          }
        });
      } else {
        // 尝试使用npm run start重启
        console.log('[系统更新] 使用npm run start重启...');
        const child = spawn('npm', ['run', 'start'], {
          cwd: projectRoot,
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        // 退出当前进程
        process.exit(0);
      }
    }, 3000);
    
  } catch (err) {
    console.error('[Admin] 重启服务器失败:', err);
    res.status(500).json({ success: false, error: '重启服务器失败: ' + err.message });
  }
});

// POST - 检查 RP-Hub 更新
router.post('/check-rphub', async (req, res) => {
  try {
    const { owner: githubOwner, repo: githubRepo } = GITHUB_REPOS.rphub;
    
    const githubApiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;
    
    const response = await fetch(githubApiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'RP-Hub-Update-Checker'
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      return res.json({
        success: true,
        data: {
          latestVersion: '未知',
          message: '无法连接到 GitHub'
        }
      });
    }
    
    const releaseData = await response.json();
    const latestVersion = releaseData.tag_name?.replace(/^v/, '') || '未知';
    
    // 记录检查更新操作
    try {
      const db = req.db;
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'check_rphub_update',
        target_type: 'system',
        target_title: 'RP-Hub 更新',
        detail: `用户 ${req.session.user.username} 检查了 RP-Hub 更新`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[system-update] logActivity 错误:', logErr.message);
    }
    
    res.json({
      success: true,
      data: {
        latestVersion: latestVersion,
        releaseName: releaseData.name || '',
        releaseBody: releaseData.body || '',
        releaseUrl: releaseData.html_url || '',
        publishedAt: releaseData.published_at || '',
        downloadUrl: releaseData.zipball_url || ''
      }
    });
  } catch (err) {
    console.error('[Admin] 检查 RP-Hub 更新失败:', err);
    res.status(500).json({ success: false, error: '检查 RP-Hub 更新失败: ' + err.message });
  }
});

// GET - 获取更新状态
router.get('/status', (req, res) => {
  const projectRoot = path.resolve(__dirname, '../../..');
  const packageJsonPath = path.join(projectRoot, 'package.json');
  
  let currentVersion = '1.6.1';
  try {
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      currentVersion = packageJson.version || currentVersion;
    }
  } catch (err) {
    console.error('[system-update] 读取package.json失败:', err);
  }
  
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
