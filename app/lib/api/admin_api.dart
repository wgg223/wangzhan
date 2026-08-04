import '../config/app_config.dart';
import '../models/admin_models.dart';
import '../models/article.dart';
import '../models/image_item.dart';
import '../models/novel.dart';
import '../models/user.dart';
import '../utils/paged.dart';
import 'api_client.dart';

export 'api_client.dart' show ApiException;

/// 管理后台接口（需要管理员权限）
class AdminApi {
  static final ApiClient _client = ApiClient.instance;
  static String _p(String path) => AppConfig.api('/admin$path');

  // ---------- 仪表盘 ----------
  static Future<DashboardStats> dashboard() async {
    final data = await _client.get(_p('/dashboard'));
    return DashboardStats.fromJson(data as Map<String, dynamic>);
  }

  // ---------- 用户管理（删除/改角色/改状态仅超管可用） ----------
  static Future<(List<User>, int)> users({int page = 1, int limit = 10, String? q, String? role}) async {
    final data = await _client.get(_p('/users'), query: {
      'page': page,
      'limit': limit,
      if (q != null && q.isNotEmpty) 'q': q,
      if (role != null && role.isNotEmpty) 'role': role,
    });
    return parsePage<User>(data as Map, 'users', User.fromJson);
  }

  /// 修改用户状态（active/disabled/pending）
  static Future<void> updateUserStatus(int id, String status) async {
    await _client.put(_p('/users/$id'), data: {'status': status});
  }

  /// 修改用户角色（仅超管，服务端校验）
  static Future<void> updateUserRole(int id, String role) async {
    await _client.put(_p('/users/$id'), data: {'role': role});
  }

  /// 删除用户（仅超管，服务端校验）
  static Future<void> deleteUser(int id) async {
    await _client.delete(_p('/users/$id'));
  }

  /// 创建用户（仅超管）
  static Future<void> createUser({
    required String username,
    required String password,
    String email = '',
    String role = 'user',
  }) async {
    await _client.post(_p('/users'), data: {
      'username': username,
      'password': password,
      'email': email,
      'role': role,
    });
  }

  /// 重置用户密码（仅超管），返回随机新密码
  static Future<String> resetPassword(int id) async {
    final data = await _client.post(_p('/users/$id/reset-password'));
    return (data as Map)['new_password']?.toString() ?? '';
  }

  /// 设置用户权限集（超管可任意改；普通 admin 仅可撤销，服务端校验）
  static Future<void> updateUserPermissions(int id, List<String> permKeys) async {
    await _client.put(_p('/users/$id/permissions'), data: {'perm_keys': permKeys});
  }

  // ---------- 文章管理 ----------
  static Future<(List<Article>, int)> articles({int page = 1, int limit = 10, String? q}) async {
    final data = await _client.get(_p('/articles'), query: {
      'page': page,
      'limit': limit,
      if (q != null && q.isNotEmpty) 'q': q,
    });
    return parsePage<Article>(data as Map, 'articles', Article.fromJson);
  }

  static Future<void> deleteArticle(int id) async {
    await _client.delete(_p('/articles/$id'));
  }

  static Future<void> updateArticleStatus(int id, String status) async {
    await _client.put(_p('/articles/$id'), data: {'status': status});
  }

  // ---------- 评论管理 ----------
  static Future<(List<Map<String, dynamic>>, int)> comments({int page = 1, int limit = 10}) async {
    final data = await _client.get(_p('/comments'), query: {'page': page, 'limit': limit});
    final map = data as Map;
    final list = map['comments'] is List ? map['comments'] as List : const [];
    return (list.map((e) => e as Map<String, dynamic>).toList(), map['total'] is int ? map['total'] as int : 0);
  }

  static Future<void> deleteComment(int id) async {
    await _client.delete(_p('/comments/$id'));
  }

  // ---------- 图片管理 ----------
  static Future<(List<ImageItem>, int)> images({int page = 1, int limit = 10, int? status}) async {
    final data = await _client.get(_p('/images'), query: {
      'page': page,
      'limit': limit,
      if (status != null) 'status': status,
    });
    return parsePage<ImageItem>(data as Map, 'images', ImageItem.fromJson);
  }

  static Future<void> setImageStatus(int id, int status) async {
    await _client.put(_p('/images/$id'), data: {'status': status});
  }

  static Future<void> deleteImage(int id) async {
    await _client.delete(_p('/images/$id'));
  }

  static Future<List<ImageCategory>> categories() async {
    final data = await _client.get(_p('/categories'));
    final list = (data as Map)['categories'] is List ? (data as Map)['categories'] : const [];
    return list.map((e) => ImageCategory.fromJson(e as Map<String, dynamic>)).toList();
  }

  static Future<void> addCategory(String name, {int sort = 0}) async {
    await _client.post(_p('/categories'), data: {'name': name, 'sort': sort});
  }

  static Future<void> deleteCategory(int id) async {
    await _client.delete(_p('/categories/$id'));
  }

  // ---------- 小说管理 ----------
  static Future<(List<Novel>, int)> novels({int page = 1, int limit = 10}) async {
    final data = await _client.get(_p('/novels'), query: {'page': page, 'limit': limit});
    return parsePage<Novel>(data as Map, 'novels', Novel.fromJson);
  }

  static Future<void> deleteNovel(int id) async {
    await _client.delete(_p('/novels/$id'));
  }

  // ---------- 设置 ----------
  static Future<Map<String, String>> settings() async {
    final data = await _client.get(_p('/settings'));
    final map = (data as Map)['settings'];
    return (map is Map)
        ? map.map((k, v) => MapEntry(k.toString(), v?.toString() ?? ''))
        : <String, String>{};
  }

  static Future<void> saveSettings(Map<String, String> values) async {
    await _client.put(_p('/settings'), data: {'settings': values});
  }

  // ---------- 日志 ----------
  static Future<(List<AdminLog>, int)> logs({int page = 1, int limit = 20}) async {
    final data = await _client.get(_p('/logs'), query: {'page': page, 'limit': limit});
    return parsePage<AdminLog>(data as Map, 'logs', AdminLog.fromJson);
  }

  static Future<void> clearLogs(int days) async {
    await _client.delete(_p('/logs'), query: {'days': days});
  }

  // ---------- 权限（仅查询，授予/撤销权限仅支持网页端操作） ----------
  static Future<List<PermissionItem>> permissions(int userId) async {
    final data = await _client.get(_p('/users/$userId/permissions'));
    final list = (data as Map)['permissions'] is List ? (data as Map)['permissions'] : const [];
    return list.map((e) => PermissionItem.fromJson(e as Map<String, dynamic>)).toList();
  }

  // ---------- 媒体 ----------
  static Future<(List<MediaItem>, int)> media({int page = 1, int limit = 20}) async {
    final data = await _client.get(_p('/media'), query: {'page': page, 'limit': limit});
    return parsePage<MediaItem>(data as Map, 'media', MediaItem.fromJson);
  }

  static Future<void> deleteMedia(int id) async {
    await _client.delete(_p('/media/$id'));
  }

  // ---------- 备份 ----------
  static Future<List<BackupItem>> backups() async {
    final data = await _client.get(_p('/backups'));
    final list = (data as Map)['backups'] is List ? (data as Map)['backups'] : const [];
    return list.map((e) => BackupItem.fromJson(e as Map<String, dynamic>)).toList();
  }

  static Future<void> createBackup(String type) async {
    await _client.post(_p('/backups'), data: {'type': type});
  }

  static Future<void> deleteBackup(String name) async {
    await _client.delete(_p('/backups/$name'));
  }

  // ---------- 系统信息 / 维护 ----------
  static Future<SystemInfo> systemInfo() async {
    final data = await _client.get(_p('/system/info'));
    return SystemInfo.fromJson(data as Map<String, dynamic>);
  }

  static Future<void> toggleMaintenance(bool enabled, {String title = '', String message = ''}) async {
    await _client.post(_p('/maintenance/toggle'), data: {
      'enabled': enabled,
      'title': title,
      'message': message,
    });
  }
}
