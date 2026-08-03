import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/message_api.dart';
import '../../models/conversation.dart';
import '../../state/auth_state.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 聊天会话页
class ConversationScreen extends StatefulWidget {
  const ConversationScreen({super.key, required this.conversationId, required this.otherName});

  final int conversationId;
  final String otherName;

  @override
  State<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends State<ConversationScreen> {
  final _controller = TextEditingController();
  final List<ChatMessage> _messages = [];
  final _scroll = ScrollController();
  bool _loading = true;
  String? _error;
  int _page = 1;
  bool _hasMore = true;

  @override
  void initState() {
    super.initState();
    MessageApi.markRead(widget.conversationId);
    _load();
  }

  Future<void> _load({bool refresh = false}) async {
    if (refresh) {
      _page = 1;
      _hasMore = true;
      setState(() => _error = null);
    }
    if (!_hasMore) return;
    try {
      final list = await MessageApi.messages(widget.conversationId, page: _page);
      setState(() {
        if (refresh || _page == 1) {
          _messages.clear();
          _messages.addAll(list.reversed);
        } else {
          _messages.insertAll(0, list.reversed);
        }
        _hasMore = list.length >= 20;
        _page++;
        _loading = false;
      });
      if (refresh || _page == 2) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
        });
      }
    } on ApiException catch (e) {
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (_) {
      setState(() {
        _error = '网络错误';
        _loading = false;
      });
    }
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    try {
      await MessageApi.send(widget.conversationId, text);
      _load(refresh: true);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发送失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.otherName)),
      body: Column(
        children: [
          Expanded(
            child: _loading && _messages.isEmpty
                ? const LoadingView()
                : _error != null && _messages.isEmpty
                    ? ErrorView(message: _error!, onRetry: () => _load(refresh: true))
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.all(12),
                        itemCount: _messages.length,
                        itemBuilder: (context, i) {
                          final m = _messages[i];
                          final myId = context.read<AuthState>().user?.id ?? 0;
                          final fromMe = m.senderId == myId;
                          return Align(
                            alignment: fromMe ? Alignment.centerRight : Alignment.centerLeft,
                            child: Container(
                              margin: const EdgeInsets.symmetric(vertical: 4),
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.7),
                              decoration: BoxDecoration(
                                color: fromMe ? const Color(0xFF2563EB) : Colors.grey.shade200,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(m.content, style: TextStyle(color: fromMe ? Colors.white : Colors.black87, fontSize: 14, height: 1.4)),
                                  const SizedBox(height: 2),
                                  Text(TimeFormat.from(m.createdAt), style: TextStyle(fontSize: 10, color: fromMe ? Colors.white70 : Colors.grey.shade500)),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
          ),
          SafeArea(
            child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: Theme.of(context).cardColor, border: Border(top: BorderSide(color: Colors.grey.shade200))),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      decoration: const InputDecoration(hintText: '输入消息...', isDense: true, contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10)),
                      onSubmitted: (_) => _send(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _send,
                    icon: const Icon(Icons.send),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
