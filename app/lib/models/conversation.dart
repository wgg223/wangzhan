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
      id: _int(json['id']),
      otherUserId: _int(json['other_user_id']),
      otherName: json['other_name']?.toString() ?? '',
      otherAvatar: json['other_avatar']?.toString() ?? '',
      lastMessage: json['last_message']?.toString() ?? '',
      lastMessageAt: json['last_message_at']?.toString(),
      unreadCount: _int(json['unread_count']),
    );
  }

  static int _int(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
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
      id: _int(json['id']),
      conversationId: _int(json['conversation_id']),
      senderId: _int(json['sender_id']),
      content: json['content']?.toString() ?? '',
      isRead: _int(json['is_read']),
      createdAt: json['created_at']?.toString(),
    );
  }

  static int _int(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
}
