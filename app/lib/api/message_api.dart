import '../config/app_config.dart';
import '../models/conversation.dart';
import 'api_client.dart';

/// 私信相关接口
class MessageApi {
  static final ApiClient _client = ApiClient.instance;

  /// 会话列表
  static Future<List<Conversation>> conversations() async {
    final data = await _client.get(AppConfig.api('/conversations'));
    final list = (data as Map)['conversations'] is List ? (data as Map)['conversations'] : const [];
    return list.map((e) => Conversation.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 创建会话（与某用户私聊）
  static Future<int> createConversation(int userId) async {
    final data = await _client.post(AppConfig.api('/conversations'), data: {'user_id': userId});
    return (data as Map)['id'] is int ? (data as Map)['id'] : int.parse('${(data as Map)['id']}');
  }

  /// 消息列表
  static Future<List<ChatMessage>> messages(int conversationId, {int page = 1}) async {
    final data = await _client.get(AppConfig.api('/conversations/$conversationId'), query: {'page': page});
    final list = (data as Map)['messages'] is List ? (data as Map)['messages'] : const [];
    return list.map((e) => ChatMessage.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// 发送消息
  static Future<void> send(int conversationId, String content) async {
    await _client.post(AppConfig.api('/conversations/$conversationId'), data: {'content': content});
  }

  /// 标记会话已读
  static Future<void> markRead(int conversationId) async {
    await _client.patch(AppConfig.api('/conversations/$conversationId/read'));
  }

  /// 未读总数
  static Future<int> unreadTotal() async {
    final data = await _client.get(AppConfig.api('/unread-total'));
    return (data as Map)['unread'] is int ? (data as Map)['unread'] : 0;
  }
}
