/// 小说模型
class Novel {
  Novel({
    required this.id,
    this.title = '',
    this.author = '',
    this.cover = '',
    this.description = '',
    this.status = 'published',
    this.chapterCount = 0,
    this.createdAt,
  });

  final int id;
  final String title;
  final String author;
  final String cover;
  final String description;
  final String status;
  final int chapterCount;
  final String? createdAt;

  factory Novel.fromJson(Map<String, dynamic> json) {
    return Novel(
      id: _int(json['id']),
      title: json['title']?.toString() ?? '',
      author: json['author']?.toString() ?? '',
      cover: json['cover_image']?.toString() ?? '',
      description: json['description']?.toString() ?? '',
      status: json['status']?.toString() ?? 'published',
      chapterCount: _int(json['chapter_count']),
      createdAt: json['created_at']?.toString(),
    );
  }

  static int _int(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
}

/// 小说章节
class NovelChapter {
  NovelChapter({
    required this.id,
    this.novelId = 0,
    this.title = '',
    this.content = '',
    this.chapterNumber = 0,
    this.fileSize = 0,
    this.createdAt,
  });

  final int id;
  final int novelId;
  final String title;
  final String content;
  final int chapterNumber;
  final int fileSize;
  final String? createdAt;

  factory NovelChapter.fromJson(Map<String, dynamic> json) {
    return NovelChapter(
      id: _int(json['id']),
      novelId: _int(json['novel_id']),
      title: json['title']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      chapterNumber: _int(json['chapter_number']),
      fileSize: _int(json['file_size']),
      createdAt: json['created_at']?.toString(),
    );
  }

  static int _int(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
}
