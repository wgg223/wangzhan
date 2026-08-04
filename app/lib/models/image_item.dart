import '../utils/coercion.dart';

/// 图片分享 - 图片模型
class ImageItem {
  ImageItem({
    required this.id,
    this.title = '',
    this.description = '',
    this.url = '',
    this.categoryId = 0,
    this.categoryName = '',
    this.userId = 0,
    this.userName = '',
    this.userAvatar = '',
    this.status = 0,
    this.downloadCount = 0,
    this.createdAt,
    this.isFavorite = false,
    this.isLiked = false,
    this.commentCount = 0,
  });

  final int id;
  final String title;
  final String description;
  final String url;
  final int categoryId;
  final String categoryName;
  final int userId;
  final String userName;
  final String userAvatar;
  final int status;
  final int downloadCount;
  final String? createdAt;
  final bool isFavorite;
  final bool isLiked;
  final int commentCount;

  bool get isApproved => status == 1;

  factory ImageItem.fromJson(Map<String, dynamic> json) {
    return ImageItem(
      id: toInt(json['id']),
      title: json['title']?.toString() ?? '',
      description: json['description']?.toString() ?? '',
      url: json['url']?.toString() ?? '',
      categoryId: toInt(json['cate_id']),
      categoryName: json['category_name']?.toString() ?? '',
      userId: toInt(json['user_id']),
      userName: json['username']?.toString() ?? '',
      userAvatar: json['user_avatar']?.toString() ?? '',
      status: toInt(json['status']),
      downloadCount: toInt(json['download_count']),
      createdAt: json['created_at']?.toString(),
      isFavorite: json['is_favorite'] == true,
      isLiked: json['is_liked'] == true,
      commentCount: toInt(json['comment_count']),
    );
  }
}

/// 图片分类
class ImageCategory {
  ImageCategory({required this.id, required this.name, this.sort = 0, this.isGuest = 0});

  final int id;
  final String name;
  final int sort;
  final int isGuest;

  factory ImageCategory.fromJson(Map<String, dynamic> json) {
    return ImageCategory(
      id: toInt(json['id']),
      name: json['name']?.toString() ?? '',
      sort: toInt(json['sort']),
      isGuest: toInt(json['is_guest']),
    );
  }
}

/// 图片评论
class ImageComment {
  ImageComment({
    required this.id,
    this.imageId = 0,
    this.userId = 0,
    this.userName = '',
    this.userAvatar = '',
    this.content = '',
    this.createdAt,
  });

  final int id;
  final int imageId;
  final int userId;
  final String userName;
  final String userAvatar;
  final String content;
  final String? createdAt;

  factory ImageComment.fromJson(Map<String, dynamic> json) {
    return ImageComment(
      id: toInt(json['id']),
      imageId: toInt(json['image_id']),
      userId: toInt(json['user_id']),
      userName: json['username']?.toString() ?? '',
      userAvatar: json['user_avatar']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      createdAt: json['created_at']?.toString(),
    );
  }
}
