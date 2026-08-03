import '../config/app_config.dart';
import '../models/novel.dart';
import 'api_client.dart';

/// 小说相关接口
class NovelApi {
  static final ApiClient _client = ApiClient.instance;

  /// 小说列表
  static Future<List<Novel>> list({int page = 1, int limit = 10}) async {
    final data = await _client.get(AppConfig.api('/novels'), query: {'page': page, 'limit': limit});
    final items = (data as Map)['novels'] is List ? (data as Map)['novels'] : const [];
    return items.map((e) => Novel.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 小说详情（含章节列表）
  static Future<(Novel, List<NovelChapter>)> detail(int id) async {
    final data = await _client.get(AppConfig.api('/novels/$id'));
    final map = data as Map;
    final novel = Novel.fromJson(map['novel'] as Map<String, dynamic>);
    final chapters = map['chapters'] is List ? map['chapters'] : const [];
    return (
      novel,
      chapters.map((e) => NovelChapter.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  /// 章节内容
  static Future<NovelChapter> chapter(int novelId, int chapterId) async {
    final data = await _client.get(AppConfig.api('/novels/$novelId/chapters/$chapterId'));
    return NovelChapter.fromJson((data as Map)['chapter'] as Map<String, dynamic>);
  }
}
