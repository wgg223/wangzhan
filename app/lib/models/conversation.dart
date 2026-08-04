import '../utils/coercion.dart';

/// 私信会话
class Conversation {
  Conversation({
    required this.id,
    this.otherUserId = 0,
    this.otherName = '',
    this.otherAvatar = '',
    this.lastMessage = '',
    this.lastMessageAt,
    this.unreadCount = 0,
  });

  final int id;
  final int otherUserId;
  final String otherName;
  final String otherAvatar;
  final String lastMessage;
  final String? lastMessageAt;
  final int unreadCount;

  factory Conversation.fromJson(Map<String, dynamic> json) {
    return Conversation(
      id: toInt(json['id']),
      otherUserId: toInt(json['other_user_id']),
      otherName: json['other_name']?.toString() ?? '',
      otherAvatar: json['other_avatar']?.toString() ?? '',
      lastMessage: json['last_message']?.toString() ?? '',
      lastMessageAt: json['last_message_at']?.toString(),
      unreadCount: toInt(json['unread_count']),
    );
  }
}

/// 私信消息
class ChatMessage {
  ChatMessage({
    required this.id,
    this.conversationId = 0,
    this.senderId = 0,
    this.content = '',
    this.isRead = 0,
    this.createdAt,
  });

  final int id;
  final int conversationId;
  final int senderId;
  final String content;
  final int isRead;
  final String? createdAt;

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    return ChatMessage(
      id: toInt(json['id']),
      conversationId: toInt(json['conversation_id']),
      senderId: toInt(json['sender_id']),
      content: json['content']?.toString() ?? '',
      isRead: toInt(json['is_read']),
      createdAt: json['created_at']?.toString(),
    );
  }
}
