import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/article.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 文章管理
class ArticlesAdminScreen extends StatefulWidget {
  const ArticlesAdminScreen({super.key});

  @override
  State<ArticlesAdminScreen> createState() => _ArticlesAdminScreenState();
}

class _ArticlesAdminScreenState extends State<ArticlesAdminScreen> {
  final List<Article> _articles = [];
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
      final (list, total) = await AdminApi.articles(page: _page);
      setState(() {
        if (refresh || _page == 1) _articles.clear();
        _articles.addAll(list);
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

  Future<void> _delete(Article a) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除文章'),
        content: Text('确定删除《${a.title}》吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok == true) {
      await AdminApi.deleteArticle(a.id);
      _load(refresh: true);
    }
  }

  Future<void> _toggleStatus(Article a) async {
    await AdminApi.updateArticleStatus(a.id, a.status == 'published' ? 'draft' : 'published');
    _load(refresh: true);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            decoration: const InputDecoration(hintText: '搜索文章标题', isDense: true),
            onSubmitted: (_) => _load(refresh: true),
          ),
        ),
        Expanded(
          child: _error != null && _articles.isEmpty
              ? ErrorView(message: _error!, onRetry: () => _load(refresh: true))
              : ListView.builder(
                  itemCount: _articles.length + (_loading ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i >= _articles.length) return const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
                    final a = _articles[i];
                    return Card(
                      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                      child: ListTile(
                        leading: a.cover.isNotEmpty
                            ? Icon(Icons.image_outlined, color: Colors.grey.shade400)
                            : const Icon(Icons.article_outlined),
                        title: Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text('${a.authorName} · ${TimeFormat.from(a.createdAt)} · ${a.status}'),
                        trailing: PopupMenuButton<String>(
                          onSelected: (v) {
                            if (v == 'status') _toggleStatus(a);
                            if (v == 'delete') _delete(a);
                          },
                          itemBuilder: (_) => [
                            PopupMenuItem(value: 'status', child: Text(a.status == 'published' ? '转为草稿' : '发布')),
                            const PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Colors.red))),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Text('共 $_total 篇文章', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
        ),
      ],
    );
  }
}
