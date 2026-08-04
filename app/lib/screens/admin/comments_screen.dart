import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../utils/time_format.dart';
import '../../widgets/paged_list_view.dart';

/// 评论管理
class CommentsScreen extends StatefulWidget {
  const CommentsScreen({super.key});

  @override
  State<CommentsScreen> createState() => _CommentsScreenState();
}

class _CommentsScreenState extends State<CommentsScreen> {
  Future<(List<Map<String, dynamic>>, int)> _fetch(int page) {
    return AdminApi.comments(page: page);
  }

  Future<void> _delete(Map<String, dynamic> c) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除评论'),
        content: const Text('确定删除这条评论吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    await AdminApi.deleteComment(c['id'] is int ? c['id'] : int.parse('${c['id']}'));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已删除')));
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: PagedListView<Map<String, dynamic>>(
            futurePage: _fetch,
            pageSize: 10,
            emptyMessage: '暂无评论',
            onRefresh: () async => setState(() {}),
            footer: Center(
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Text('已加载全部',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
              ),
            ),
            itemBuilder: (context, c, _) {
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: ListTile(
                  leading: CircleAvatar(
                    child: Text(
                      (c['username']?.toString() ?? '?').isNotEmpty
                          ? c['username'].toString()[0]
                          : '?',
                    ),
                  ),
                  title: Text(c['content']?.toString() ?? '',
                      maxLines: 2, overflow: TextOverflow.ellipsis),
                  subtitle: Text(
                      '${c['username']} · ${TimeFormat.from(c['created_at']?.toString())} · ${c['status']}'),
                  trailing: IconButton(
                    icon: const Icon(Icons.delete_outline, color: Colors.red),
                    onPressed: () => _delete(c),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
