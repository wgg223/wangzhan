/// 管理后台 - 各类模型

/// 仪表盘统计
class DashboardStats {
  DashboardStats({
    this.userCount = 0,
    this.articleCount = 0,
    this.imageCount = 0,
    this.novelCount = 0,
    this.commentCount = 0,
    this.pendingImages = 0,
    this.pendingComments = 0,
    this.todayVisits = 0,
    this.uptime = '',
    this.dbSize = '',
  });

  final int userCount;
  final int articleCount;
  final int imageCount;
  final int novelCount;
  final int commentCount;
  final int pendingImages;
  final int pendingComments;
  final int todayVisits;
  final String uptime;
  final String dbSize;

  factory DashboardStats.fromJson(Map<String, dynamic> json) {
    int i(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
    return DashboardStats(
      userCount: i(json['user_count']),
      articleCount: i(json['article_count']),
      imageCount: i(json['image_count']),
      novelCount: i(json['novel_count']),
      commentCount: i(json['comment_count']),
      pendingImages: i(json['pending_images']),
      pendingComments: i(json['pending_comments']),
      todayVisits: i(json['today_visits']),
      uptime: json['uptime']?.toString() ?? '',
      dbSize: json['db_size']?.toString() ?? '',
    );
  }
}

/// 操作日志
class AdminLog {
  AdminLog({
    required this.id,
    this.userId = 0,
    this.username = '',
    this.action = '',
    this.targetType = '',
    this.targetTitle = '',
    this.detail = '',
    this.ip = '',
    this.createdAt,
  });

  final int id;
  final int userId;
  final String username;
  final String action;
  final String targetType;
  final String targetTitle;
  final String detail;
  final String ip;
  final String? createdAt;

  factory AdminLog.fromJson(Map<String, dynamic> json) {
    return AdminLog(
      id: _int(json['id']),
      userId: _int(json['user_id']),
      username: json['username']?.toString() ?? '',
      action: json['action']?.toString() ?? '',
      targetType: json['target_type']?.toString() ?? '',
      targetTitle: json['target_title']?.toString() ?? '',
      detail: json['detail']?.toString() ?? '',
      ip: json['ip']?.toString() ?? '',
      createdAt: json['created_at']?.toString(),
    );
  }

  static int _int(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
}

/// 权限项
class PermissionItem {
  PermissionItem({required this.permKey, this.permName = '', this.description = '', this.granted = false});

  final String permKey;
  final String permName;
  final String description;
  final bool granted;

  factory PermissionItem.fromJson(Map<String, dynamic> json) {
    return PermissionItem(
      permKey: json['perm_key']?.toString() ?? '',
      permName: json['perm_name']?.toString() ?? '',
      description: json['description']?.toString() ?? '',
      granted: json['granted'] == true,
    );
  }
}

/// 媒体文件
class MediaItem {
  MediaItem({
    required this.id,
    this.filename = '',
    this.originalName = '',
    this.filePath = '',
    this.fileType = '',
    this.fileSize = 0,
    this.uploadedBy = 0,
    this.uploaderName = '',
    this.createdAt,
  });

  final int id;
  final String filename;
  final String originalName;
  final String filePath;
  final String fileType;
  final int fileSize;
  final int uploadedBy;
  final String uploaderName;
  final String? createdAt;

  factory MediaItem.fromJson(Map<String, dynamic> json) {
    return MediaItem(
      id: _int(json['id']),
      filename: json['filename']?.toString() ?? '',
      originalName: json['original_name']?.toString() ?? '',
      filePath: json['file_path']?.toString() ?? '',
      fileType: json['file_type']?.toString() ?? '',
      fileSize: _int(json['file_size']),
      uploadedBy: _int(json['uploaded_by']),
      uploaderName: json['uploader_name']?.toString() ?? '',
      createdAt: json['created_at']?.toString(),
    );
  }

  static int _int(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
}

/// 备份文件
class BackupItem {
  BackupItem({required this.name, this.size = 0, this.createdAt = '', this.type = ''});

  final String name;
  final int size;
  final String createdAt;
  final String type;

  factory BackupItem.fromJson(Map<String, dynamic> json) {
    return BackupItem(
      name: json['name']?.toString() ?? '',
      size: json['size'] is int ? json['size'] : int.tryParse('${json['size']}') ?? 0,
      createdAt: json['created_at']?.toString() ?? '',
      type: json['type']?.toString() ?? '',
    );
  }
}

/// 系统信息
class SystemInfo {
  SystemInfo({
    this.platform = '',
    this.nodeVersion = '',
    this.uptime = '',
    this.memory = '',
    this.cpu = '',
    this.dbSize = '',
    this.dbTables = 0,
    this.uploadSize = '',
    this.backupSize = '',
    this.cacheHitRate = '',
  });

  final String platform;
  final String nodeVersion;
  final String uptime;
  final String memory;
  final String cpu;
  final String dbSize;
  final int dbTables;
  final String uploadSize;
  final String backupSize;
  final String cacheHitRate;

  factory SystemInfo.fromJson(Map<String, dynamic> json) {
    return SystemInfo(
      platform: json['platform']?.toString() ?? '',
      nodeVersion: json['node_version']?.toString() ?? '',
      uptime: json['uptime']?.toString() ?? '',
      memory: json['memory']?.toString() ?? '',
      cpu: json['cpu']?.toString() ?? '',
      dbSize: json['db_size']?.toString() ?? '',
      dbTables: json['db_tables'] is int ? json['db_tables'] : int.tryParse('${json['db_tables']}') ?? 0,
      uploadSize: json['upload_size']?.toString() ?? '',
      backupSize: json['backup_size']?.toString() ?? '',
      cacheHitRate: json['cache_hit_rate']?.toString() ?? '',
    );
  }
}
