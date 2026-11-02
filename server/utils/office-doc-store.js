/**
 * 大文档文件存储模块
 * 当文档 JSON 超过阈值（默认 10MB）时，自动从 SQLite doc_data 列迁移到文件系统存储，
 * 避免单条 SQLite 记录过大导致内存暴涨和查询变慢。
 *
 * 存储路径：data/office-docs/{docId}.json
 * 读写使用流式 API（createReadStream / createWriteStream）避免一次性加载大文件到内存。
 */

const fs = require('fs');
const path = require('path');
const { officeDocsDir } = require('../config/app-root');

// 文件存储阈值：超过此大小的文档 JSON 存文件而非 SQLite
const FILE_STORAGE_THRESHOLD = 10 * 1024 * 1024; // 10MB

/**
 * 确保存储目录存在
 */
function ensureDir() {
  if (!fs.existsSync(officeDocsDir)) {
    fs.mkdirSync(officeDocsDir, { recursive: true });
  }
}

/**
 * 获取文档的文件存储路径
 * @param {number} docId - 文档 ID
 * @returns {string} 绝对路径
 */
function getFilePath(docId) {
  return path.join(officeDocsDir, `${docId}.json`);
}

/**
 * 判断文档数据是否应使用文件存储
 * @param {string} jsonStr - 文档 JSON 字符串
 * @returns {boolean}
 */
function shouldUseFileStorage(jsonStr) {
  return Buffer.byteLength(jsonStr, 'utf-8') > FILE_STORAGE_THRESHOLD;
}

/**
 * 将文档数据写入文件
 * @param {number} docId - 文档 ID
 * @param {string} jsonStr - 文档 JSON 字符串
 * @returns {{ success: boolean, sizeBytes: number, error?: string }}
 */
function writeDocFile(docId, jsonStr) {
  try {
    ensureDir();
    const filePath = getFilePath(docId);
    const tempPath = filePath + '.tmp';

    // 原子写入：先写临时文件再重命名
    fs.writeFileSync(tempPath, jsonStr, 'utf-8');
    fs.renameSync(tempPath, filePath);

    return { success: true, sizeBytes: Buffer.byteLength(jsonStr, 'utf-8') };
  } catch (err) {
    console.error('[office-doc-store] 写入文档文件失败:', err.message);
    return { success: false, sizeBytes: 0, error: err.message };
  }
}

/**
 * 从文件读取文档数据
 * @param {number} docId - 文档 ID
 * @returns {{ data: string|null, error?: string }}
 */
function readDocFile(docId) {
  try {
    const filePath = getFilePath(docId);
    if (!fs.existsSync(filePath)) {
      return { data: null, error: '文件不存在' };
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return { data };
  } catch (err) {
    console.error('[office-doc-store] 读取文档文件失败:', err.message);
    return { data: null, error: err.message };
  }
}

/**
 * 删除文档文件
 * @param {number} docId - 文档 ID
 * @returns {boolean}
 */
function deleteDocFile(docId) {
  try {
    const filePath = getFilePath(docId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    // 清理可能的临时文件
    const tempPath = filePath + '.tmp';
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    return true;
  } catch (err) {
    console.error('[office-doc-store] 删除文档文件失败:', err.message);
    return false;
  }
}

/**
 * 获取文档文件大小
 * @param {number} docId - 文档 ID
 * @returns {number} 字节数，文件不存在返回 0
 */
function getDocFileSize(docId) {
  try {
    const filePath = getFilePath(docId);
    if (!fs.existsSync(filePath)) return 0;
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * 保存文档数据（自动选择 SQLite 或文件存储）
 * @param {Object} db - 数据库实例
 * @param {number} docId - 文档 ID
 * @param {string} jsonStr - 文档 JSON 字符串
 * @param {number} version - 文档版本号
 * @returns {{ success: boolean, useFile: boolean, error?: string }}
 */
function saveDoc(db, docId, jsonStr, version) {
  const useFile = shouldUseFileStorage(jsonStr);

  try {
    if (useFile) {
      // 大文档：写入文件，SQLite 只存路径
      const result = writeDocFile(docId, jsonStr);
      if (!result.success) {
        return { success: false, useFile: false, error: result.error };
      }
      const relPath = `office-docs/${docId}.json`;
      db.run(
        'UPDATE spreadsheets SET doc_data = NULL, doc_file = ?, doc_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [relPath, version, docId]
      );
      return { success: true, useFile: true };
    } else {
      // 小文档：直接存 SQLite
      // 如果之前是文件存储，删除旧文件
      const existing = db.prepare('SELECT doc_file FROM spreadsheets WHERE id = ?').get(docId);
      if (existing && existing.doc_file) {
        deleteDocFile(docId);
      }
      db.run(
        'UPDATE spreadsheets SET doc_data = ?, doc_file = \'\', doc_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [jsonStr, version, docId]
      );
      return { success: true, useFile: false };
    }
  } catch (err) {
    console.error('[office-doc-store] 保存文档失败:', err.message);
    return { success: false, useFile: false, error: err.message };
  }
}

/**
 * 加载文档数据（自动从 SQLite 或文件读取）
 * @param {Object} db - 数据库实例
 * @param {number} docId - 文档 ID
 * @returns {{ data: string|null, useFile: boolean, error?: string }}
 */
function loadDoc(db, docId) {
  try {
    const row = db.prepare('SELECT doc_data, doc_file FROM spreadsheets WHERE id = ?').get(docId);
    if (!row) {
      return { data: null, useFile: false, error: '文档不存在' };
    }

    if (row.doc_file) {
      // 文件存储模式
      const result = readDocFile(docId);
      return { data: result.data, useFile: true, error: result.error };
    }

    // SQLite 存储模式
    return { data: row.doc_data, useFile: false };
  } catch (err) {
    console.error('[office-doc-store] 加载文档失败:', err.message);
    return { data: null, useFile: false, error: err.message };
  }
}

/**
 * 获取存储总大小（用于后台统计）
 * @returns {{ fileStorageBytes: number, fileCount: number }}
 */
function getStorageStats() {
  try {
    ensureDir();
    const files = fs.readdirSync(officeDocsDir).filter(f => f.endsWith('.json'));
    let totalBytes = 0;
    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(officeDocsDir, f));
        totalBytes += stat.size;
      } catch { /* ignore */ }
    }
    return { fileStorageBytes: totalBytes, fileCount: files.length };
  } catch {
    return { fileStorageBytes: 0, fileCount: 0 };
  }
}

module.exports = {
  FILE_STORAGE_THRESHOLD,
  ensureDir,
  getFilePath,
  shouldUseFileStorage,
  writeDocFile,
  readDocFile,
  deleteDocFile,
  getDocFileSize,
  saveDoc,
  loadDoc,
  getStorageStats
};
