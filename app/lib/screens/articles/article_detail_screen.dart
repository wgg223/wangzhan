import 'package:flutter/material.dart';
import 'package:flutter_html/flutter_html.dart';
import 'package:provider/provider.dart';

import '../../api/article_api.dart';
import '../../models/article.dart';
import '../../state/auth_state.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 文章详情页
class ArticleDetailScreen extends StatefulWidget {
  const ArticleDetailScreen({super.key, required this.articleId});

  final int articleId;

  @override
  State<ArticleDetailScreen> createState() => _ArticleDetailScreenState();
}

class _ArticleDetailScreenState extends State<ArticleDetailScreen> {
  late Future<Article> _future;
  bool _liked = false;
  int _likeCount = 0;

  @override
  void initState() {
    super.initState();
    _future = ArticleApi.detail(widget.articleId).then((a) {
      _liked = a.isLiked;
      _likeCount = a.likeCount;
      return a;
    });
  }

  void _reload() {
    setState(() {
      _future = ArticleApi.detail(widget.articleId).then((a) {
        _liked = a.isLiked;
        _likeCount = a.likeCount;
        return a;
      });
    });
  }

  Future<void> _toggleLike(Article article) async {
    final auth = context.read<AuthState>();
    if (!auth.isLoggedIn) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请先登录')));
      return;
    }
    try {
      final liked = await ArticleApi.toggleLike(article.id);
      setState(() {
        _liked = liked;
        _likeCount += liked ? 1 : -1;
      });
    } catch (_) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('操作失败')));
    }
  }

  Future<void> _addComment(Article article) async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发表评论'),
        content: TextField(controller: controller, maxLines: 3, decoration: const InputDecoration(hintText: '说点什么...')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('发表')),
        ],
      ),
    );
    if (result == null || result.trim().isEmpty) return;
    try {
      await ArticleApi.addComment(article.id, result.trim());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('评论已发表')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('文章详情')),
      body: FutureView(
        future: _future,
        reload: _reload,
        builder: (context, article) {
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(article.title, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
              const SizedBox(height: 10),
              Row(
                children: [
                  CircleAvatar(radius: 12, backgroundColor: Colors.grey.shade300, child: Text(article.authorName.isNotEmpty ? article.authorName[0] : '?', style: const TextStyle(fontSize: 12))),
                  const SizedBox(width: 8),
                  Text(article.authorName, style: const TextStyle(fontSize: 13)),
                  const SizedBox(width: 12),
                  Text(TimeFormat.from(article.createdAt), style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                ],
              ),
              const Divider(height: 28),
              if (article.content.isNotEmpty)
                Html(data: article.content, style: {'body': Style(fontSize: FontSize(15), lineHeight: LineHeight(1.7))}),
              if (article.attachments.isNotEmpty) ...[
                const SizedBox(height: 16),
                const Text('附件', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                ...article.attachments.map((att) => ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.insert_drive_file_outlined),
                      title: Text(att.filename, maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(att.sizeLabel),
                      trailing: Text('下载 ${att.downloadCount} 次', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                    )),
              ],
              const SizedBox(height: 16),
              Row(
                children: [
                  _ActionChip(
                    icon: _liked ? Icons.thumb_up : Icons.thumb_up_outlined,
                    label: '$_likeCount',
                    active: _liked,
                    onTap: () => _toggleLike(article),
                  ),
                  const SizedBox(width: 8),
                  _ActionChip(
                    icon: Icons.chat_bubble_outline,
                    label: '${article.commentCount}',
                    onTap: () => _addComment(article),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () => _addComment(article),
                icon: const Icon(Icons.edit_outlined, size: 18),
                label: const Text('写评论'),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _ActionChip extends StatelessWidget {
  const _ActionChip({required this.icon, required this.label, this.active = false, this.onTap});

  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: active ? const Color(0xFF2563EB).withOpacity(0.1) : Colors.transparent,
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Row(
            children: [
              Icon(icon, size: 18, color: active ? const Color(0xFF2563EB) : Colors.grey.shade600),
              const SizedBox(width: 4),
              Text(label, style: TextStyle(fontSize: 13, color: active ? const Color(0xFF2563EB) : Colors.grey.shade700)),
            ],
          ),
        ),
      ),
    );
  }
}
