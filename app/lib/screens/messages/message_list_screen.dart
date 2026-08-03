import 'package:flutter/material.dart';

import '../../api/message_api.dart';
import '../../models/conversation.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';
import 'conversation_screen.dart';

/// 私信会话列表
class MessageListScreen extends StatefulWidget {
  const MessageListScreen({super.key});

  @override
  State<MessageListScreen> createState() => _MessageListScreenState();
}

class _MessageListScreenState extends State<MessageListScreen> {
  late Future<List<Conversation>> _future;

  @override
  void initState() {
    super.initState();
    _future = MessageApi.conversations();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('私信')),
      body: FutureView(
        future: _future,
        reload: () => setState(() => _future = MessageApi.conversations()),
        builder: (context, list) {
          if (list.isEmpty) return const EmptyView(message: '暂无会话');
          return ListView.separated(
            itemCount: list.length,
            separatorBuilder: (c, i) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final c = list[i];
              return ListTile(
                leading: CircleAvatar(radius: 20, child: Text(c.otherName.isNotEmpty ? c.otherName[0] : '?')),
                title: Text(c.otherName, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text(c.lastMessage, maxLines: 1, overflow: TextOverflow.ellipsis),
                trailing: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(TimeFormat.from(c.lastMessageAt), style: TextStyle(fontSize: 11, color: Colors.grey.shade500)),
                    if (c.unreadCount > 0) ...[
                      const SizedBox(height: 4),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: const BoxDecoration(color: Colors.red, borderRadius: BorderRadius.all(Radius.circular(10))),
                        child: Text('${c.unreadCount}', style: const TextStyle(color: Colors.white, fontSize: 11)),
                      ),
                    ],
                  ],
                ),
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ConversationScreen(conversationId: c.id, otherName: c.otherName))),
              );
            },
          );
        },
      ),
    );
  }
}
