/// 诗词模型（题目）
class Poem {
  Poem({
    this.id = '',
    this.title = '',
    this.author = '',
    this.paragraphs = const [],
    this.dynasty = '',
    this.category = '',
  });

  final String id;
  final String title;
  final String author;
  final List<String> paragraphs;
  final String dynasty;
  final String category;

  String get fullText => paragraphs.join('，').replaceAll('。', '，') + '。';

  factory Poem.fromJson(Map<String, dynamic> json) {
    return Poem(
      id: json['id']?.toString() ?? '',
      title: json['t']?.toString() ?? json['title']?.toString() ?? '',
      author: json['a']?.toString() ?? json['author']?.toString() ?? '',
      paragraphs: (json['p'] is List)
          ? json['p'].map((e) => e.toString()).toList()
          : const [],
      dynasty: json['d']?.toString() ?? json['dynasty']?.toString() ?? '',
      category: json['c']?.toString() ?? json['category']?.toString() ?? '',
    );
  }
}

/// 排行榜条目
class LeaderboardEntry {
  LeaderboardEntry({
    this.id = 0,
    this.userId = 0,
    this.username = '',
    this.gameMode = '',
    this.difficulty = '',
    this.score = 0,
    this.comboMax = 0,
    this.correctCount = 0,
    this.totalCount = 0,
    this.duration = 0,
    this.createdAt,
  });

  final int id;
  final int userId;
  final String username;
  final String gameMode;
  final String difficulty;
  final int score;
  final int comboMax;
  final int correctCount;
  final int totalCount;
  final int duration;
  final String? createdAt;

  factory LeaderboardEntry.fromJson(Map<String, dynamic> json) {
    int i(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
    return LeaderboardEntry(
      id: i(json['id']),
      userId: i(json['user_id']),
      username: json['username']?.toString() ?? '',
      gameMode: json['game_mode']?.toString() ?? '',
      difficulty: json['difficulty']?.toString() ?? '',
      score: i(json['score']),
      comboMax: i(json['combo_max']),
      correctCount: i(json['correct_count']),
      totalCount: i(json['total_count']),
      duration: i(json['duration']),
      createdAt: json['created_at']?.toString(),
    );
  }
}
