import 'package:flutter/material.dart';

import '../../api/community_api.dart';
import '../../models/community.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 通知列表
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  late Future<List<AppNotification>> _future;

  @override
  void initState() {
    super.initState();
    _future = CommunityApi.notifications();
    CommunityApi.markNotificationsRead();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('通知')),
      body: FutureView(
        future: _future,
        reload: () => setState(() => _future = CommunityApi.notifications()),
        builder: (context, list) {
          if (list.isEmpty) return const EmptyView(message: '暂无通知');
          return ListView.separated(
            itemCount: list.length,
            separatorBuilder: (c, i) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final n = list[i];
              return ListTile(
                leading: CircleAvatar(
                  backgroundColor: n.isRead == 0 ? const Color(0xFF2563EB).withOpacity(0.15) : Colors.grey.shade200,
                  child: Icon(_typeIcon(n.type), size: 18, color: n.isRead == 0 ? const Color(0xFF2563EB) : Colors.grey),
                ),
                title: Text(n.title, style: TextStyle(fontWeight: n.isRead == 0 ? FontWeight.w600 : FontWeight.normal)),
                subtitle: Text(n.content, maxLines: 2, overflow: TextOverflow.ellipsis),
                trailing: Text(TimeFormat.from(n.createdAt), style: TextStyle(fontSize: 11, color: Colors.grey.shade400)),
              );
            },
          );
        },
      ),
    );
  }

  IconData _typeIcon(String type) {
    switch (type) {
      case 'like':
        return Icons.thumb_up_outlined;
      case 'follow':
        return Icons.person_add_outlined;
      case 'comment':
        return Icons.chat_bubble_outline;
      case 'system':
        return Icons.campaign_outlined;
      default:
        return Icons.notifications_outlined;
    }
  }
}
