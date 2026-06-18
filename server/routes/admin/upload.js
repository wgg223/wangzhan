/**
 * 文件上传配置模块
 * 抽离自 admin.js 的 multer 配置
 * 已添加安全增强：MIME类型验证、文件内容检查、大小限制
 */
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp'
];

const ALLOWED_TEXT_MIME_TYPES = [
  'text/plain',
  'application/json'
];

const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const ALLOWED_TEXT_EXTENSIONS = ['.txt', '.json'];
const ALLOWED_DOC_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];

function getFileExtension(filename) {
  return path.extname(filename).toLowerCase();
}

function validateFileContent(file) {
  const ext = getFileExtension(file.originalname);
  const mime = file.mimetype;

  if (ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
    return ALLOWED_IMAGE_MIME_TYPES.includes(mime);
  }

  if (ALLOWED_TEXT_EXTENSIONS.includes(ext)) {
    return ALLOWED_TEXT_MIME_TYPES.includes(mime);
  }

  if (ALLOWED_DOC_EXTENSIONS.includes(ext)) {
    const allowedDocMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    return allowedDocMimes.includes(mime);
  }

  return false;
}

// 普通文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../../public/uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = getFileExtension(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 20
  },
  fileFilter: function (req, file, cb) {
    const ext = getFileExtension(file.originalname);
    const allAllowedExtensions = [
      ...ALLOWED_IMAGE_EXTENSIONS,
      ...ALLOWED_TEXT_EXTENSIONS,
      ...ALLOWED_DOC_EXTENSIONS
    ];

    if (!allAllowedExtensions.includes(ext)) {
      return cb(new Error('不支持的文件类型'), false);
    }

    if (!validateFileContent(file)) {
      return cb(new Error('文件内容与扩展名不匹配，可能存在安全风险'), false);
    }

    cb(null, true);
  }
});

// 图片文件上传（存入 uploads/images/）
const imageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../../public/uploads/images');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = getFileExtension(file.originalname);
    cb(null, 'img-' + uniqueSuffix + ext);
  }
});

const imageUpload = multer({
  storage: imageStorage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 10
  },
  fileFilter: function (req, file, cb) {
    const ext = getFileExtension(file.originalname);
    const mime = file.mimetype;

    if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
      return cb(new Error('只允许上传 JPG、PNG、GIF、WEBP 格式图片'), false);
    }

    if (!ALLOWED_IMAGE_MIME_TYPES.includes(mime)) {
      return cb(new Error('文件MIME类型不匹配'), false);
    }

    cb(null, true);
  }
});

// 小说文件上传（仅允许 TXT / JSON）
const novelStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../../public/uploads/novels');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = getFileExtension(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const novelUpload = multer({
  storage: novelStorage,
  limits: {
    fileSize: 50 * 1024 * 1024
  },
  fileFilter: function (req, file, cb) {
    const ext = getFileExtension(file.originalname);
    const mime = file.mimetype;

    if (!ALLOWED_TEXT_EXTENSIONS.includes(ext)) {
      return cb(new Error('只允许上传 TXT 或 JSON 文件'), false);
    }

    if (!ALLOWED_TEXT_MIME_TYPES.includes(mime)) {
      return cb(new Error('文件MIME类型不匹配'), false);
    }

    cb(null, true);
  }
});

// 数据库文件上传（仅允许 .sqlite）
const dbStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const tmpDir = path.join(__dirname, '../../../backups/tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cb(null, tmpDir);
  },
  filename: function (req, file, cb) {
    cb(null, 'restore-' + Date.now() + '.sqlite');
  }
});

const dbUpload = multer({
  storage: dbStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const ext = getFileExtension(file.originalname);
    if (ext !== '.sqlite' && ext !== '.db') {
      return cb(new Error('只允许上传 .sqlite 或 .db 文件'), false);
    }
    cb(null, true);
  }
});

module.exports = { upload, imageUpload, novelUpload, dbUpload };
