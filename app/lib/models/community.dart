import '../utils/coercion.dart';

/// 社区动态
class CommunityPost {
  CommunityPost({
    required this.id,
    this.userId = 0,
    this.userName = '',
    this.userAvatar = '',
    this.content = '',
    this.targetType = '',
    this.targetId = 0,
    this.targetTitle = '',
    this.images = const [],
    this.likeCount = 0,
    this.commentCount = 0,
    this.isLiked = false,
    this.createdAt,
  });

  final int id;
  final int userId;
  final String userName;
  final String userAvatar;
  final String content;
  final String targetType;
  final int targetId;
  final String targetTitle;
  final List<String> images;
  final int likeCount;
  final int commentCount;
  final bool isLiked;
  final String? createdAt;

  factory CommunityPost.fromJson(Map<String, dynamic> json) {
    return CommunityPost(
      id: toInt(json['id']),
      userId: toInt(json['user_id']),
      userName: json['username']?.toString() ?? '',
      userAvatar: json['user_avatar']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      targetType: json['target_type']?.toString() ?? '',
      targetId: toInt(json['target_id']),
      targetTitle: json['target_title']?.toString() ?? '',
      images: (json['images'] is List)
          ? json['images'].map((e) => e.toString()).toList()
          : const [],
      likeCount: toInt(json['like_count']),
      commentCount: toInt(json['comment_count']),
      isLiked: json['is_liked'] == true,
      createdAt: json['created_at']?.toString(),
    );
  }
}

/// 通知
class AppNotification {
  AppNotification({
    required this.id,
    this.type = '',
    this.title = '',
    this.content = '',
    this.fromUserId = 0,
    this.fromUserName = '',
    this.fromAvatar = '',
    this.targetType = '',
    this.targetId = '',
    this.isRead = 0,
    this.createdAt,
  });

  final int id;
  final String type;
  final String title;
  final String content;
  final int fromUserId;
  final String fromUserName;
  final String fromAvatar;
  final String targetType;
  final String targetId;
  final int isRead;
  final String? createdAt;

  factory AppNotification.fromJson(Map<String, dynamic> json) {
    return AppNotification(
      id: toInt(json['id']),
      type: json['type']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      fromUserId: toInt(json['from_user_id']),
      fromUserName: json['from_username']?.toString() ?? '',
      fromAvatar: json['from_avatar']?.toString() ?? '',
      targetType: json['target_type']?.toString() ?? '',
      targetId: json['target_id']?.toString() ?? '',
      isRead: toInt(json['is_read']),
      createdAt: json['created_at']?.toString(),
    );
  }
}
