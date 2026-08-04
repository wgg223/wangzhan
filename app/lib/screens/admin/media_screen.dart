import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../config/app_config.dart';
import '../../models/admin_models.dart';
import '../../utils/time_format.dart';
import '../../widgets/paged_list_view.dart';

/// 媒体管理
class MediaScreen extends StatefulWidget {
  const MediaScreen({super.key});

  @override
  State<MediaScreen> createState() => _MediaScreenState();
}

class _MediaScreenState extends State<MediaScreen> {
  Future<(List<MediaItem>, int)> _fetch(int page) {
    return AdminApi.media(page: page);
  }

  Future<void> _delete(MediaItem m) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除媒体'),
        content: Text('确定删除「${m.originalName.isNotEmpty ? m.originalName : m.filename}」吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    await AdminApi.deleteMedia(m.id);
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
          child: PagedListView<MediaItem>(
            futurePage: _fetch,
            pageSize: 20,
            emptyMessage: '暂无媒体文件',
            onRefresh: () async => setState(() {}),
            footer: Center(
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Text('已加载全部',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
              ),
            ),
            itemBuilder: (context, m, _) {
              final isImage = (m.fileType ?? '').startsWith('image/');
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: ListTile(
                  leading: isImage
                      ? ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: Image.network(
                            AppConfig.asset(m.filePath),
                            width: 48,
                            height: 48,
                            fit: BoxFit.cover,
                            errorBuilder: (c, u, e) => const Icon(Icons.image_outlined),
                          ),
                        )
                      : const Icon(Icons.insert_drive_file_outlined),
                  title: Text(m.originalName.isNotEmpty ? m.originalName : m.filename,
                      maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text('${m.uploaderName} · ${TimeFormat.from(m.createdAt)}'),
                  trailing: IconButton(
                    icon: const Icon(Icons.delete_outline, color: Colors.red),
                    onPressed: () => _delete(m),
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
