import '../utils/coercion.dart';

/// 文章模型
class Article {
  Article({
    required this.id,
    this.title = '',
    this.summary = '',
    this.content = '',
    this.cover = '',
    this.authorId = 0,
    this.authorName = '',
    this.authorAvatar = '',
    this.category = '',
    this.status = 'published',
    this.viewCount = 0,
    this.likeCount = 0,
    this.commentCount = 0,
    this.createdAt,
    this.tags = const [],
    this.attachments = const [],
    this.isLiked = false,
  });

  final int id;
  final String title;
  final String summary;
  final String content;
  final String cover;
  final int authorId;
  final String authorName;
  final String authorAvatar;
  final String category;
  final String status;
  final int viewCount;
  final int likeCount;
  final int commentCount;
  final String? createdAt;
  final List<String> tags;
  final List<Attachment> attachments;
  final bool isLiked;

  factory Article.fromJson(Map<String, dynamic> json) {
    return Article(
      id: toInt(json['id']),
      title: json['title']?.toString() ?? '',
      summary: json['summary']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      cover: json['cover']?.toString() ?? '',
      authorId: toInt(json['author_id']),
      authorName: json['author_name']?.toString() ?? '',
      authorAvatar: json['author_avatar']?.toString() ?? '',
      category: json['category']?.toString() ?? '',
      status: json['status']?.toString() ?? 'published',
      viewCount: toInt(json['view_count']),
      likeCount: toInt(json['like_count']),
      commentCount: toInt(json['comment_count']),
      createdAt: json['created_at']?.toString(),
      tags: (json['tags'] is List) ? json['tags'].map((e) => e.toString()).toList() : const [],
      attachments: (json['attachments'] is List)
          ? json['attachments']
              .map((e) => Attachment.fromJson(e as Map<String, dynamic>))
              .toList()
          : const [],
      isLiked: json['is_liked'] == true,
    );
  }
}

/// 文章附件
class Attachment {
  Attachment({
    required this.id,
    this.filename = '',
    this.filesize = 0,
    this.filetype = '',
    this.filepath = '',
    this.downloadCount = 0,
  });

  final int id;
  final String filename;
  final int filesize;
  final String filetype;
  final String filepath;
  final int downloadCount;

  String get sizeLabel {
    if (filesize >= 1024 * 1024) return '${(filesize / 1024 / 1024).toStringAsFixed(1)} MB';
    if (filesize >= 1024) return '${(filesize / 1024).toStringAsFixed(0)} KB';
    return '$filesize B';
  }

  factory Attachment.fromJson(Map<String, dynamic> json) {
    return Attachment(
      id: toInt(json['id']),
      filename: json['filename']?.toString() ?? '',
      filesize: toInt(json['filesize']),
      filetype: json['filetype']?.toString() ?? '',
      filepath: json['filepath']?.toString() ?? '',
      downloadCount: toInt(json['download_count']),
    );
  }
}

/// 文章评论
class ArticleComment {
  ArticleComment({
    required this.id,
    this.articleId = 0,
    this.userId = 0,
    this.content = '',
    this.userName = '',
    this.userAvatar = '',
    this.createdAt,
  });

  final int id;
  final int articleId;
  final int userId;
  final String content;
  final String userName;
  final String userAvatar;
  final String? createdAt;

  factory ArticleComment.fromJson(Map<String, dynamic> json) {
    return ArticleComment(
      id: toInt(json['id']),
      articleId: toInt(json['article_id']),
      userId: toInt(json['user_id']),
      content: json['content']?.toString() ?? '',
      userName: (json['nickname']?.toString() ?? '').isNotEmpty
          ? json['nickname'].toString()
          : (json['username']?.toString() ?? ''),
      userAvatar: json['avatar']?.toString() ?? '',
      createdAt: json['created_at']?.toString(),
    );
  }
}
