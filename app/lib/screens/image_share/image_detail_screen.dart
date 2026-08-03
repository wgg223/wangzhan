import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/image_share_api.dart';
import '../../config/app_config.dart';
import '../../models/image_item.dart';
import '../../state/auth_state.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 图片详情页
class ImageDetailScreen extends StatefulWidget {
  const ImageDetailScreen({super.key, required this.imageId});

  final int imageId;

  @override
  State<ImageDetailScreen> createState() => _ImageDetailScreenState();
}

class _ImageDetailScreenState extends State<ImageDetailScreen> {
  late Future<ImageItem> _future;
  bool _favorited = false;
  bool _liked = false;

  @override
  void initState() {
    super.initState();
    _future = ImageShareApi.detail(widget.imageId).then((img) {
      _favorited = img.isFavorite;
      _liked = img.isLiked;
      return img;
    });
  }

  Future<void> _toggle(String kind) async {
    final auth = context.read<AuthState>();
    if (!auth.isLoggedIn) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请先登录')));
      return;
    }
    try {
      if (kind == 'favorite') {
        final v = await ImageShareApi.toggleFavorite(widget.imageId);
        setState(() => _favorited = v);
      } else {
        final v = await ImageShareApi.toggleLike(widget.imageId);
        setState(() => _liked = v);
      }
    } catch (_) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('操作失败')));
    }
  }

  Future<void> _addComment() async {
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
      await ImageShareApi.addComment(widget.imageId, result.trim());
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('评论已发表')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('图片详情')),
      body: FutureView(
        future: _future,
        builder: (context, image) {
          return ListView(
            padding: const EdgeInsets.all(12),
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: CachedNetworkImage(
                  imageUrl: AppConfig.asset(image.url),
                  fit: BoxFit.contain,
                  placeholder: (c, u) => Container(height: 260, color: Colors.grey.shade200),
                  errorWidget: (c, u, e) => Container(height: 260, color: Colors.grey.shade200, child: const Icon(Icons.broken_image_outlined)),
                ),
              ),
              const SizedBox(height: 12),
              Text(image.title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              if (image.description.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(image.description, style: TextStyle(fontSize: 14, color: Colors.grey.shade600)),
              ],
              const SizedBox(height: 10),
              Row(
                children: [
                  CircleAvatar(radius: 12, backgroundColor: Colors.grey.shade300, child: Text(image.userName.isNotEmpty ? image.userName[0] : '?', style: const TextStyle(fontSize: 12))),
                  const SizedBox(width: 8),
                  Text(image.userName, style: const TextStyle(fontSize: 13)),
                  const SizedBox(width: 12),
                  Text(TimeFormat.from(image.createdAt), style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                  const Spacer(),
                  Text('${image.categoryName}', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  ActionChip(
                    avatar: Icon(_favorited ? Icons.favorite : Icons.favorite_border, size: 18, color: _favorited ? Colors.red : null),
                    label: Text(_favorited ? '已收藏' : '收藏'),
                    onPressed: () => _toggle('favorite'),
                  ),
                  const SizedBox(width: 8),
                  ActionChip(
                    avatar: Icon(_liked ? Icons.thumb_up : Icons.thumb_up_outlined, size: 18, color: _liked ? const Color(0xFF2563EB) : null),
                    label: const Text('点赞'),
                    onPressed: () => _toggle('like'),
                  ),
                  const SizedBox(width: 8),
                  ActionChip(
                    avatar: const Icon(Icons.chat_bubble_outline, size: 18),
                    label: const Text('评论'),
                    onPressed: _addComment,
                  ),
                ],
              ),
              const Divider(height: 32),
              const Text('评论', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              FutureBuilder<List<ImageComment>>(
                future: ImageShareApi.comments(widget.imageId),
                builder: (context, snapshot) {
                  if (snapshot.connectionState != ConnectionState.done) {
                    return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
                  }
                  final comments = snapshot.data ?? [];
                  if (comments.isEmpty) return const EmptyView(message: '暂无评论');
                  return Column(
                    children: comments
                        .map((c) => ListTile(
                              contentPadding: EdgeInsets.zero,
                              leading: CircleAvatar(radius: 14, child: Text(c.userName.isNotEmpty ? c.userName[0] : '?', style: const TextStyle(fontSize: 12))),
                              title: Text(c.userName, style: const TextStyle(fontSize: 13)),
                              subtitle: Text(c.content),
                              trailing: Text(TimeFormat.from(c.createdAt), style: TextStyle(fontSize: 11, color: Colors.grey.shade400)),
                            ))
                        .toList(),
                  );
                },
              ),
            ],
          );
        },
      ),
    );
  }
}
