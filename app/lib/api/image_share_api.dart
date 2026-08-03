import '../config/app_config.dart';
import '../models/image_item.dart';
import 'api_client.dart';

export 'api_client.dart' show ApiException;

/// 图片分享相关接口
class ImageShareApi {
  static final ApiClient _client = ApiClient.instance;

  /// 分类列表
  static Future<List<ImageCategory>> categories() async {
    final data = await _client.get(AppConfig.api('/image-categories'));
    final list = (data as Map)['categories'] is List ? (data as Map)['categories'] : const [];
    return list.map((e) => ImageCategory.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 图片列表
  static Future<List<ImageItem>> list({
    int page = 1,
    int limit = 20,
    int? categoryId,
    String? q,
  }) async {
    final data = await _client.get(AppConfig.api('/images'), query: {
      'page': page,
      'limit': limit,
      if (categoryId != null) 'category': categoryId,
      if (q != null && q.isNotEmpty) 'q': q,
    });
    final items = (data as Map)['images'] is List ? (data as Map)['images'] : const [];
    return items.map((e) => ImageItem.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 图片详情
  static Future<ImageItem> detail(int id) async {
    final data = await _client.get(AppConfig.api('/images/$id'));
    return ImageItem.fromJson((data as Map)['image'] as Map<String, dynamic>);
  }

  /// 我的收藏
  static Future<List<ImageItem>> favorites({int page = 1}) async {
    final data = await _client.get(AppConfig.api('/images/favorites'), query: {'page': page});
    final items = (data as Map)['images'] is List ? (data as Map)['images'] : const [];
    return items.map((e) => ImageItem.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 收藏/取消收藏
  static Future<bool> toggleFavorite(int imageId) async {
    final data = await _client.post(AppConfig.api('/images/$imageId/favorite'));
    return (data as Map)['favorited'] == true;
  }

  /// 点赞/取消点赞
  static Future<bool> toggleLike(int imageId) async {
    final data = await _client.post(AppConfig.api('/images/$imageId/like'));
    return (data as Map)['liked'] == true;
  }

  /// 图片评论列表
  static Future<List<ImageComment>> comments(int imageId) async {
    final data = await _client.get(AppConfig.api('/images/$imageId/comments'));
    final list = (data as Map)['comments'] is List ? (data as Map)['comments'] : const [];
    return list.map((e) => ImageComment.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 发表评论
  static Future<void> addComment(int imageId, String content) async {
    await _client.post(AppConfig.api('/images/$imageId/comments'), data: {'content': content});
  }

  /// 上传图片（multipart）
  static Future<void> upload({
    required List<String> filePaths,
    required String title,
    String description = '',
    required int categoryId,
  }) async {
    await _client.upload(AppConfig.api('/images'), filePaths, fields: {
      'title': title,
      'description': description,
      'cate_id': categoryId,
    });
  }
}
