import '../config/app_config.dart';
import '../models/article.dart';
import 'api_client.dart';

export 'api_client.dart' show ApiException;

/// 文章相关接口
class ArticleApi {
  static final ApiClient _client = ApiClient.instance;

  /// 文章列表（支持分页和搜索）
  static Future<List<Article>> list({int page = 1, int limit = 10, String? q, String? tag}) async {
    final data = await _client.get(AppConfig.api('/articles'), query: {
      'page': page,
      'limit': limit,
      if (q != null && q.isNotEmpty) 'q': q,
      if (tag != null && tag.isNotEmpty) 'tag': tag,
    });
    final raw = (data as Map)['articles'];
    return raw is List
        ? raw.map((e) => Article.fromJson(e as Map<String, dynamic>)).toList()
        : const <Article>[];
  }

  /// 文章详情
  static Future<Article> detail(int id) async {
    final data = await _client.get(AppConfig.api('/articles/$id'));
    return Article.fromJson((data as Map)['article'] as Map<String, dynamic>);
  }

  /// 文章评论列表
  static Future<List<dynamic>> comments(int articleId, {int page = 1}) async {
    final data = await _client.get(AppConfig.api('/articles/$articleId/comments'), query: {'page': page});
    return (data as Map)['comments'] is List ? (data as Map)['comments'] : const [];
  }

  /// 发表评论
  static Future<void> addComment(int articleId, String content) async {
    await _client.post(AppConfig.api('/articles/$articleId/comments'), data: {'content': content});
  }

  /// 点赞/取消点赞
  static Future<bool> toggleLike(int articleId) async {
    final data = await _client.post(AppConfig.api('/articles/$articleId/like'));
    return (data as Map)['liked'] == true;
  }
}
