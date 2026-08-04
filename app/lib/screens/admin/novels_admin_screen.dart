import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/novel.dart';
import '../../utils/time_format.dart';
import '../../widgets/paged_list_view.dart';

/// 小说管理
class NovelsAdminScreen extends StatefulWidget {
  const NovelsAdminScreen({super.key});

  @override
  State<NovelsAdminScreen> createState() => _NovelsAdminScreenState();
}

class _NovelsAdminScreenState extends State<NovelsAdminScreen> {
  Future<(List<Novel>, int)> _fetch(int page) {
    return AdminApi.novels(page: page);
  }

  Future<void> _delete(Novel n) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除小说'),
        content: Text('确定删除《${n.title}》及其全部章节吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    await AdminApi.deleteNovel(n.id);
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
          child: PagedListView<Novel>(
            futurePage: _fetch,
            pageSize: 10,
            emptyMessage: '暂无小说',
            onRefresh: () async => setState(() {}),
            footer: Center(
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Text('已加载全部',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
              ),
            ),
            itemBuilder: (context, n, _) {
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: ListTile(
                  leading: const Icon(Icons.menu_book_outlined),
                  title: Text(n.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text(
                      '作者：${n.author} · ${n.chapterCount} 章 · ${TimeFormat.from(n.createdAt)}'),
                  trailing: IconButton(
                    icon: const Icon(Icons.delete_outline, color: Colors.red),
                    onPressed: () => _delete(n),
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
