import '../utils/coercion.dart';

/// 用户模型
class User {
  User({
    required this.id,
    this.username = '',
    this.nickname,
    this.avatar = '',
    this.role = 'user',
    this.email = '',
    this.bio = '',
    this.status = 'active',
    this.createdAt,
    this.followerCount = 0,
    this.followingCount = 0,
    this.articleCount = 0,
  });

  final int id;
  final String username;
  final String? nickname;
  final String avatar;
  final String role;
  final String email;
  final String bio;
  final String status;
  final String? createdAt;
  final int followerCount;
  final int followingCount;
  final int articleCount;

  String get displayName => (nickname != null && nickname!.isNotEmpty) ? nickname! : username;

  bool get isAdmin => role == 'admin' || role == 'super_admin';
  bool get isSuperAdmin => role == 'super_admin';

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: toInt(json['id']),
      username: json['username']?.toString() ?? '',
      nickname: json['nickname']?.toString(),
      avatar: json['avatar']?.toString() ?? '',
      role: json['role']?.toString() ?? 'user',
      email: json['email']?.toString() ?? '',
      bio: json['bio']?.toString() ?? '',
      status: json['status']?.toString() ?? 'active',
      createdAt: json['created_at']?.toString(),
      followerCount: toInt(json['follower_count']),
      followingCount: toInt(json['following_count']),
      articleCount: toInt(json['article_count']),
    );
  }
}
