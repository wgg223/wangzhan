import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/article.dart';
import '../../utils/time_format.dart';
import '../../widgets/paged_list_view.dart';

/// 文章管理
class ArticlesAdminScreen extends StatefulWidget {
  const ArticlesAdminScreen({super.key});

  @override
  State<ArticlesAdminScreen> createState() => _ArticlesAdminScreenState();
}

class _ArticlesAdminScreenState extends State<ArticlesAdminScreen> {
  final _search = TextEditingController();

  Future<(List<Article>, int)> _fetch(int page) {
    return AdminApi.articles(page: page, q: _search.text.trim());
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
      if (mounted) setState(() {});
    }
  }

  Future<void> _toggleStatus(Article a) async {
    await AdminApi.updateArticleStatus(a.id, a.status == 'published' ? 'draft' : 'published');
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            controller: _search,
            decoration: const InputDecoration(hintText: '搜索文章标题', isDense: true),
            onSubmitted: (_) => setState(() {}),
          ),
        ),
        Expanded(
          child: PagedListView<Article>(
            futurePage: _fetch,
            pageSize: 10,
            emptyMessage: '暂无文章',
            onRefresh: () async => setState(() {}),
            itemBuilder: (context, a, _) {
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
                      PopupMenuItem(
                          value: 'status',
                          child: Text(a.status == 'published' ? '转为草稿' : '发布')),
                      const PopupMenuItem(
                          value: 'delete',
                          child: Text('删除', style: TextStyle(color: Colors.red))),
                    ],
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
