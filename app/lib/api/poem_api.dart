import '../config/app_config.dart';
import '../models/poem.dart';
import 'api_client.dart';

/// 诗词游戏相关接口
class PoemApi {
  static final ApiClient _client = ApiClient.instance;

  /// 随机获取诗词题目
  static Future<List<Poem>> random({int count = 10, String? category}) async {
    final data = await _client.get(AppConfig.api('/poems/random'), query: {
      'count': count,
      if (category != null && category.isNotEmpty) 'category': category,
    });
    final list = data is Map && data['poems'] is List ? data['poems'] : const [];
    return list.map((e) => Poem.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 排行榜
  static Future<List<LeaderboardEntry>> leaderboard({
    String gameMode = '飞花令',
    String difficulty = 'easy',
    int limit = 20,
  }) async {
    final data = await _client.get(AppConfig.api('/poem-leaderboard'), query: {
      'game_mode': gameMode,
      'difficulty': difficulty,
      'limit': limit,
    });
    final list = data is Map && data['leaderboard'] is List ? data['leaderboard'] : const [];
    return list.map((e) => LeaderboardEntry.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 提交成绩
  static Future<void> submitScore({
    required String gameMode,
    required String difficulty,
    required int score,
    int comboMax = 0,
    int correctCount = 0,
    int totalCount = 0,
    int duration = 0,
    String category = '全部',
  }) async {
    await _client.post(AppConfig.api('/poem-leaderboard'), data: {
      'game_mode': gameMode,
      'difficulty': difficulty,
      'score': score,
      'combo_max': comboMax,
      'correct_count': correctCount,
      'total_count': totalCount,
      'duration': duration,
      'category': category,
    });
  }
}
