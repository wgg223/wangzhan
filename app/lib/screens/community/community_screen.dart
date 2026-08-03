import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/community_api.dart';
import '../../models/community.dart';
import '../../state/auth_state.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 社区动态页
class CommunityScreen extends StatefulWidget {
  const CommunityScreen({super.key});

  @override
  State<CommunityScreen> createState() => _CommunityScreenState();
}

class _CommunityScreenState extends State<CommunityScreen> {
  final List<CommunityPost> _posts = [];
  int _page = 1;
  bool _loading = false;
  bool _hasMore = true;
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
      _hasMore = true;
      setState(() => _error = null);
    }
    if (!_hasMore) return;
    setState(() => _loading = true);
    try {
      final list = await CommunityApi.feed(page: _page, limit: 10);
      setState(() {
        if (refresh || _page == 1) _posts.clear();
        _posts.addAll(list);
        _hasMore = list.length >= 10;
        _page++;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = '网络错误，请检查连接');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _post() async {
    final auth = context.read<AuthState>();
    if (!auth.isLoggedIn) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请先登录')));
      return;
    }
    final controller = TextEditingController();
    final content = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('发布动态'),
        content: TextField(controller: controller, maxLines: 4, decoration: const InputDecoration(hintText: '分享你的想法...')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('发布')),
        ],
      ),
    );
    if (content == null || content.trim().isEmpty) return;
    try {
      await CommunityApi.post(content.trim());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('发布成功')));
        _load(refresh: true);
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _toggleLike(CommunityPost post) async {
    try {
      await CommunityApi.toggleLike('post', post.id);
      _load(refresh: true);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('社区动态')),
      floatingActionButton: FloatingActionButton(
        onPressed: _post,
        child: const Icon(Icons.edit),
      ),
      body: RefreshIndicator(
        onRefresh: () => _load(refresh: true),
        child: _error != null && _posts.isEmpty
            ? ListView(children: [Padding(padding: const EdgeInsets.only(top: 80), child: ErrorView(message: _error!, onRetry: () => _load(refresh: true)))])
            : ListView.builder(
                padding: const EdgeInsets.only(bottom: 80),
                itemCount: _posts.length + (_hasMore ? 1 : 0),
                itemBuilder: (context, i) {
                  if (i >= _posts.length) {
                    return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
                  }
                  final post = _posts[i];
                  return Card(
                    margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              CircleAvatar(radius: 16, child: Text(post.userName.isNotEmpty ? post.userName[0] : '?')),
                              const SizedBox(width: 10),
                              Expanded(child: Text(post.userName, style: const TextStyle(fontWeight: FontWeight.w600))),
                              Text(TimeFormat.from(post.createdAt), style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                            ],
                          ),
                          const SizedBox(height: 10),
                          Text(post.content, style: const TextStyle(fontSize: 15, height: 1.5)),
                          if (post.targetTitle.isNotEmpty) ...[
                            const SizedBox(height: 8),
                            Container(
                              padding: const EdgeInsets.all(8),
                              decoration: BoxDecoration(color: Colors.grey.shade100, borderRadius: BorderRadius.circular(6)),
                              child: Text('引用：${post.targetTitle}', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                            ),
                          ],
                          const SizedBox(height: 10),
                          Row(
                            children: [
                              InkWell(
                                onTap: () => _toggleLike(post),
                                child: Row(
                                  children: [
                                    Icon(post.isLiked ? Icons.thumb_up : Icons.thumb_up_outlined, size: 16, color: post.isLiked ? const Color(0xFF2563EB) : Colors.grey.shade500),
                                    const SizedBox(width: 4),
                                    Text('${post.likeCount}', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 16),
                              Icon(Icons.chat_bubble_outline, size: 16, color: Colors.grey.shade500),
                              const SizedBox(width: 4),
                              Text('${post.commentCount}', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                            ],
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
      ),
    );
  }
}
