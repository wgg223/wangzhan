/**
 * 项目根目录与可写数据目录解析
 * - 正常 node 运行：项目根目录（server/config 的上级上级）
 * - pkg 打包成 exe 后：__dirname 指向只读的虚拟快照，所有可写数据
 *   （数据库、上传文件、备份）必须放到可执行文件所在目录
 */
const path = require('path');

const projectRoot = process.pkg
  ? path.dirname(process.execPath)
  : path.resolve(__dirname, '../..');

module.exports = {
  projectRoot,
  publicDir: path.join(projectRoot, 'public'),
  uploadsDir: path.join(projectRoot, 'public', 'uploads'),
  backupDir: path.join(projectRoot, 'backups'),
  databasePath: path.join(projectRoot, 'database.sqlite')
};
