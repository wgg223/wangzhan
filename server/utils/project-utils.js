/**
 * 项目管理工具函数
 * 作用：支撑后台"项目管理"功能的公共逻辑，包括：
 *   - 项目定义读取（数据库优先，硬编码兜底）
 *   - 项目数据统计（按表统计记录数）
 *   - 项目关联文件清理（防目录穿越）
 *   - 从 GitHub 部署/更新项目代码（git clone / pull）
 * 安全要点：所有动态拼接的表名必须经过 TABLE_WHITELIST 白名单校验，
 *           所有文件目录操作都做了越界防护。
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');   // 同步执行系统命令（git 操作）
const { queryOne, queryAll, saveDatabase } = require('../config/database');
const { PROJECT_DEFINITIONS, DEPENDENT_TABLES } = require('../config/constants');
const fsSafe = require('./fs-safe');             // 安全文件删除工具
const logger = require('./logger');              // 日志模块

// 表名白名单：只允许对实际存在的业务表做拼接查询/删除，防止表名注入
const TABLE_WHITELIST = new Set([
  'app_setup', 'users', 'pages', 'articles', 'article_drafts', 'tags', 'content_tags',
  'content_versions', 'media', 'settings', 'permissions', 'user_permissions',
  'permission_applications', 'comments', 'novels', 'novel_chapters', 'media_comments',
  'activity_logs', 'image_categories', 'images', 'image_logs',
  'image_configs', 'image_comments', 'image_favorites', 'image_tags', 'image_tag_relations',
  'image_shares', 'internal_messages', 'user_follows', 'notifications', 'content_likes',
  'community_posts', 'community_post_comments', 'conversations', 'private_messages',
  'user_message_settings', 'projects', 'ai_conversations', 'ai_messages', 'ai_world_book',
  'ai_memories', 'ai_branches', 'ai_chat_providers', 'oauth_providers', 'user_oauth_bindings',
  'ai_roles', 'ai_quota', 'ai_models', 'ai_settings', 'ai_knowledge_docs', 'ai_knowledge_chunks',
  'prompt_sections', 'prompt_categories', 'prompts', 'prompt_comments', 'article_attachments',
  'api_tokens', 'api_access_logs', 'ai_image_providers', 'ai_image_records', 'ai_image_user_keys'
]);

/**
 * 校验表名是否在白名单内
 * @param {string} t - 表名
 * @returns {boolean} true=合法表名
 */
function isAllowedTable(t) {
  return TABLE_WHITELIST.has(t);
}

/**
 * 获取项目信息（优先从数据库读取，后备使用硬编码定义）
 * @param {Object} db - 数据库实例
 * @param {string} projectId - 项目ID（如 blog/novel/image）
 * @returns {Object|null} 项目信息对象（tables/file_dirs 已解析为数组）
 */
function getProjectInfo(db, projectId) {
  // 尝试从 projects 表读取（数据库中的配置优先，可被后台编辑）
  const project = queryOne(db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
  if (project) {
    return {
      ...project,
      tables: parseJsonArray(project.tables),        // JSON 字符串 → 数组
      file_dirs: parseJsonArray(project.file_dirs)
    };
  }
  // 后备：使用硬编码定义（projects 表尚未初始化时）
  return PROJECT_DEFINITIONS[projectId] || null;
}

/**
 * 获取所有已启用项目定义（优先从数据库读取，后备使用硬编码定义）
 * @param {Object} db - 数据库实例
 * @returns {Object[]} 项目定义数组
 */
function getAllProjectDefinitions(db) {
  let projects = [];
  try {
    // 查询所有启用中的项目，按创建时间升序
    const dbProjects = queryAll(db, 'SELECT * FROM projects WHERE is_active = 1 ORDER BY created_at ASC');
    if (dbProjects.length > 0) {
      projects = dbProjects.map(p => ({
        ...p,
        tables: parseJsonArray(p.tables),
        file_dirs: parseJsonArray(p.file_dirs)
      }));
    }
  } catch (e) { /* 表不存在等异常，回退硬编码定义 */ }

  // 数据库无数据或读取失败时，用内置定义兜底
  if (projects.length === 0) {
    projects = Object.values(PROJECT_DEFINITIONS);
  }

  return projects;
}

/**
 * 安全解析 JSON 数组字段，脏数据不抛异常
 * @param {string} json - 形如 '["a","b"]' 的 JSON 字符串
 * @returns {Array} 解析后的数组；解析失败返回空数组
 */
function parseJsonArray(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 获取项目统计数据
 * @param {Object} db - 数据库实例
 * @param {string[]} tables - 表名列表
 * @returns {{ stats: Object, totalRecords: number }} 各表记录数与总记录数
 * 说明：对每张表执行 COUNT(*)，表名必须通过白名单校验；
 *       单表失败（表不存在）记为 0 不中断整体统计。
 */
function getProjectStats(db, tables) {
  const stats = {};
  let totalRecords = 0;
  tables.forEach(table => {
    try {
      if (!isAllowedTable(table)) {
        throw new Error('非法表名: ' + table);      // 防表名注入
      }
      const count = queryOne(db, `SELECT COUNT(*) as count FROM ${table}`);
      stats[table] = count ? count.count : 0;
      totalRecords += stats[table];
    } catch (e) {
      stats[table] = 0;                             // 单表失败不影响其他表
    }
  });
  return { stats, totalRecords };
}

/**
 * 清理项目关联的文件
 * @param {string[]} fileDirs - 文件目录列表（相对 public 的路径）
 * @returns {Promise<number>} 已删除的文件数量
 * 安全逻辑：
 *   1. 目录解析后必须位于 public 目录内（防 ../ 穿越）；
 *   2. 目录不能等于 public 根目录本身；
 *   3. 只删除普通文件，不递归删除子目录。
 */
async function cleanProjectFiles(fileDirs) {
  let deletedFiles = 0;
  const uploadsDir = require('../config/app-root').publicDir;   // public 目录绝对路径
  for (const dir of fileDirs) {
    // 防止 file_dirs 越界（如 ../ 或空字符串指向 public 根目录），只允许 public 内且非根目录
    const dirPath = path.resolve(uploadsDir, dir);
    if (dirPath === uploadsDir || !dirPath.startsWith(uploadsDir + path.sep)) continue;
    try {
      const stat = await fs.promises.stat(dirPath).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;   // 目录不存在/非目录则跳过
      const files = await fs.promises.readdir(dirPath);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const fileStat = await fs.promises.lstat(filePath);
          if (fileStat.isFile()) {                  // 只删文件，不碰子目录
            if (await fsSafe.safeUnlink(filePath)) {
              deletedFiles++;
            }
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
  }
  return deletedFiles;
}

/**
 * 验证 GitHub 仓库 URL 是否有效
 * @param {string} url - GitHub 仓库 URL
 * @returns {boolean} 是否有效
 * 支持格式: https://github.com/owner/repo 或 https://github.com/owner/repo.git
 */
function isValidGithubUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/)?(\.git)?$/.test(url.trim());
}

/**
 * 从 GitHub URL 中提取 owner/repo
 * @param {string} url - GitHub 仓库 URL
 * @returns {{ owner: string, repo: string }|null} 解析失败返回 null
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
 * 流程：
 *   1. 校验项目存在与 URL 合法（防命令注入，URL 经过正则白名单）；
 *   2. 目标目录 deploy/projects/{projectId}；
 *   3. 已存在 → git fetch + reset 到 origin/main（失败回退 master）；
 *      不存在 → git clone；
 *   4. 更新数据库中的部署状态为 success/failed；
 *   5. 返回给用户的 output 截断（2000 字符）。
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
      // 目录已存在，执行 git pull 更新（强制重置到远端最新）
      isUpdate = true;
      output = execSync(
        `cd "${projectDir}" && git fetch origin && git reset --hard origin/main 2>&1 || git reset --hard origin/master 2>&1`,
        { timeout: 120000, encoding: 'utf-8' }   // 2 分钟超时
      );
    } else {
      // 首次克隆（URL 已通过白名单正则校验，不会注入额外命令）
      output = execSync(
        `git clone "${githubUrl.trim()}" "${projectDir}" 2>&1`,
        { timeout: 120000, encoding: 'utf-8' }
      );
    }

    // 更新部署状态为成功
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
      output: output.substring(0, 2000) // 限制输出长度，避免把海量 git 日志返回给页面
    };
  } catch (err) {
    // 部署失败：更新状态为 failed
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
 * 说明：目录存在即视为已部署；尝试读取最近一次 commit 信息，失败不报错。
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
  getAllProjectDefinitions,
  getProjectStats,
  cleanProjectFiles,
  isValidGithubUrl,
  parseGithubUrl,
  deployFromGithub,
  getDeployStatus,
  TABLE_WHITELIST,
  isAllowedTable
};
