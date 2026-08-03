import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/novel.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 小说管理
class NovelsAdminScreen extends StatefulWidget {
  const NovelsAdminScreen({super.key});

  @override
  State<NovelsAdminScreen> createState() => _NovelsAdminScreenState();
}

class _NovelsAdminScreenState extends State<NovelsAdminScreen> {
  final List<Novel> _novels = [];
  int _page = 1;
  int _total = 0;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool refresh = false}) async {
    if (_loading) return;
    if (refresh) {
      _page = 1;
      setState(() => _error = null);
    }
    setState(() => _loading = true);
    try {
      final (list, total) = await AdminApi.novels(page: _page);
      setState(() {
        if (refresh || _page == 1) _novels.clear();
        _novels.addAll(list);
        _total = total;
        _page++;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = '网络错误');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
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
    if (ok == true) {
      await AdminApi.deleteNovel(n.id);
      _load(refresh: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: _error != null && _novels.isEmpty
              ? ErrorView(message: _error!, onRetry: () => _load(refresh: true))
              : ListView.builder(
                  itemCount: _novels.length + (_loading ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i >= _novels.length) return const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
                    final n = _novels[i];
                    return Card(
                      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                      child: ListTile(
                        leading: const Icon(Icons.menu_book_outlined),
                        title: Text(n.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text('作者：${n.author} · ${n.chapterCount} 章 · ${TimeFormat.from(n.createdAt)}'),
                        trailing: IconButton(
                          icon: const Icon(Icons.delete_outline, color: Colors.red),
                          onPressed: () => _delete(n),
                        ),
                      ),
                    );
                  },
                ),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Text('共 $_total 部小说', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
        ),
      ],
    );
  }
}
