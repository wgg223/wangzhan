import '../config/app_config.dart';
import '../models/community.dart';
import '../models/user.dart';
import 'api_client.dart';

/// 社区相关接口
class CommunityApi {
  static final ApiClient _client = ApiClient.instance;

  /// 动态流
  static Future<List<CommunityPost>> feed({int page = 1, int limit = 10}) async {
    final data = await _client.get(AppConfig.api('/community/feed'), query: {'page': page, 'limit': limit});
    final list = (data as Map)['posts'] is List ? (data as Map)['posts'] : const [];
    return list.map((e) => CommunityPost.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 发布动态
  static Future<void> post(String content) async {
    await _client.post(AppConfig.api('/community/posts'), data: {'content': content});
  }

  /// 关注/取消关注
  static Future<bool> toggleFollow(int userId) async {
    final data = await _client.post(AppConfig.api('/users/$userId/follow'));
    return (data as Map)['following'] == true;
  }

  /// 通用点赞（type: article | image | comment）
  static Future<bool> toggleLike(String type, int targetId) async {
    final data = await _client.post(AppConfig.api('/like/$type/$targetId'));
    return (data as Map)['liked'] == true;
  }

  /// 用户主页信息
  static Future<User> userProfile(int userId) async {
    final data = await _client.get(AppConfig.api('/users/$userId'));
    return User.fromJson((data as Map)['user'] as Map<String, dynamic>);
  }

  /// 通知列表
  static Future<List<AppNotification>> notifications({int page = 1}) async {
    final data = await _client.get(AppConfig.api('/notifications'), query: {'page': page});
    final list = (data as Map)['notifications'] is List ? (data as Map)['notifications'] : const [];
    return list.map((e) => AppNotification.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 标记通知已读
  static Future<void> markNotificationsRead() async {
    await _client.post(AppConfig.api('/notifications/read-all'));
  }
}
