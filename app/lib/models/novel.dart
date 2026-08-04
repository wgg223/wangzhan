import '../utils/coercion.dart';

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
      id: toInt(json['id']),
      title: json['title']?.toString() ?? '',
      author: json['author']?.toString() ?? '',
      cover: json['cover_image']?.toString() ?? '',
      description: json['description']?.toString() ?? '',
      status: json['status']?.toString() ?? 'published',
      chapterCount: toInt(json['chapter_count']),
      createdAt: json['created_at']?.toString(),
    );
  }
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
      id: toInt(json['id']),
      novelId: toInt(json['novel_id']),
      title: json['title']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      chapterNumber: toInt(json['chapter_number']),
      fileSize: toInt(json['file_size']),
      createdAt: json['created_at']?.toString(),
    );
  }
}
