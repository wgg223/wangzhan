/**
 * 项目管理工具函数
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { queryOne, queryAll, saveDatabase } = require('../config/database');
const { PROJECT_DEFINITIONS, DEPENDENT_TABLES } = require('../config/constants');
const fsSafe = require('./fs-safe');
const logger = require('./logger');

/**
 * 获取项目信息（优先从数据库读取，后备使用硬编码定义）
 * @param {Object} db - 数据库实例
 * @param {string} projectId - 项目ID
 * @returns {Object|null} 项目信息对象
 */
function getProjectInfo(db, projectId) {
  // 尝试从 projects 表读取
  const project = queryOne(db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
  if (project) {
    return {
      ...project,
      tables: JSON.parse(project.tables),
      file_dirs: JSON.parse(project.file_dirs || '[]')
    };
  }
  // 后备：使用硬编码定义
  return PROJECT_DEFINITIONS[projectId] || null;
}

/**
 * 获取项目统计数据
 * @param {Object} db - 数据库实例
 * @param {string[]} tables - 表名列表
 * @returns {{ stats: Object, totalRecords: number }}
 */
function getProjectStats(db, tables) {
  const stats = {};
  let totalRecords = 0;
  tables.forEach(table => {
    try {
      const count = queryOne(db, `SELECT COUNT(*) as count FROM ${table}`);
      stats[table] = count ? count.count : 0;
      totalRecords += stats[table];
    } catch (e) {
      stats[table] = 0;
    }
  });
  return { stats, totalRecords };
}

/**
 * 清理项目关联的文件
 * @param {string[]} fileDirs - 文件目录列表
 * @returns {number} 已删除的文件数量
 */
function cleanProjectFiles(fileDirs) {
  let deletedFiles = 0;
  const uploadsDir = path.join(__dirname, '../../public');
  fileDirs.forEach(dir => {
    const dirPath = path.join(uploadsDir, dir);
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath);
      files.forEach(file => {
        const filePath = path.join(dirPath, file);
        if (fs.lstatSync(filePath).isFile()) {
          if (fsSafe.safeUnlinkSync(filePath)) {
            deletedFiles++;
          }
        }
      });
    }
  });
  return deletedFiles;
}

/**
 * 验证 GitHub 仓库 URL 是否有效
 * @param {string} url - GitHub 仓库 URL
 * @returns {boolean} 是否有效
 */
function isValidGithubUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // 支持格式: https://github.com/owner/repo 或 https://github.com/owner/repo.git
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/)?(\.git)?$/.test(url.trim());
}

/**
 * 从 GitHub URL 中提取 owner/repo
 * @param {string} url - GitHub 仓库 URL
 * @returns {{ owner: string, repo: string }|null}
 */
function parseGithubUrl(url) {
  if (!url) return null;
  const match = url.trim().match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

/**
 * 部署项目 - 从 GitHub 克隆/拉取代码到本地
 * @param {Object} db - 数据库实例
 * @param {string} projectId - 项目ID
 * @param {string} githubUrl - GitHub 仓库 URL
 * @returns {Promise<{success: boolean, message: string, output?: string}>}
 */
async function deployFromGithub(db, projectId, githubUrl) {
  const project = getProjectInfo(db, projectId);
  if (!project) {
    return { success: false, message: '项目不存在' };
  }

  if (!isValidGithubUrl(githubUrl)) {
    return { success: false, message: '无效的 GitHub 仓库 URL' };
  }

  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) {
    return { success: false, message: '无法解析 GitHub 仓库信息' };
  }

  // 部署目录: deploy/projects/{projectId}/
  const deployBaseDir = path.join(__dirname, '../../deploy/projects');
  const projectDir = path.join(deployBaseDir, projectId);

  try {
    // 确保部署基础目录存在
    if (!fs.existsSync(deployBaseDir)) {
      fs.mkdirSync(deployBaseDir, { recursive: true });
    }

    let output = '';
    let isUpdate = false;

    if (fs.existsSync(projectDir)) {
      // 目录已存在，执行 git pull 更新
      isUpdate = true;
      output = execSync(
        `cd "${projectDir}" && git fetch origin && git reset --hard origin/main 2>&1 || git reset --hard origin/master 2>&1`,
        { timeout: 120000, encoding: 'utf-8' }
      );
    } else {
      // 首次克隆
      output = execSync(
        `git clone "${githubUrl.trim()}" "${projectDir}" 2>&1`,
        { timeout: 120000, encoding: 'utf-8' }
      );
    }

    // 更新部署状态
    db.run(
      "UPDATE projects SET github_url = ?, deploy_status = 'success' WHERE id = ?",
      [githubUrl.trim(), projectId]
    );
    saveDatabase();

    const action = isUpdate ? '更新' : '部署';
    logger.info(`[项目部署] ${action}成功: ${projectId} (${githubUrl})`);

    return {
      success: true,
      message: `项目「${project.name}」${action}成功！代码已保存到 deploy/projects/${projectId}`,
      output: output.substring(0, 2000) // 限制输出长度
    };
  } catch (err) {
    // 更新部署状态为失败
    try {
      db.run(
        "UPDATE projects SET github_url = ?, deploy_status = 'failed' WHERE id = ?",
        [githubUrl.trim(), projectId]
      );
      saveDatabase();
    } catch (e) {
      // 忽略
    }

    const errorMsg = err.stderr || err.message || String(err);
    logger.error(`[项目部署] 失败: ${projectId} - ${errorMsg}`);

    return {
      success: false,
      message: `项目「${project.name}」部署失败: ${errorMsg.substring(0, 500)}`,
      output: errorMsg.substring(0, 2000)
    };
  }
}

/**
 * 检查项目部署状态
 * @param {string} projectId - 项目ID
 * @returns {{ deployed: boolean, path: string|null, lastCommit: string|null }}
 */
function getDeployStatus(projectId) {
  const projectDir = path.join(__dirname, `../../deploy/projects/${projectId}`);

  if (!fs.existsSync(projectDir)) {
    return { deployed: false, path: null, lastCommit: null };
  }

  let lastCommit = null;
  try {
    lastCommit = execSync(
      `cd "${projectDir}" && git log --oneline -1 2>&1`,
      { timeout: 10000, encoding: 'utf-8' }
    ).trim();
  } catch (e) {
    // 忽略
  }

  return {
    deployed: true,
    path: `deploy/projects/${projectId}`,
    lastCommit: lastCommit
  };
}

module.exports = {
  getProjectInfo,
  getProjectStats,
  cleanProjectFiles,
  isValidGithubUrl,
  parseGithubUrl,
  deployFromGithub,
  getDeployStatus
};
