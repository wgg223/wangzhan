import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../config/app_config.dart';
import '../../models/admin_models.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 媒体管理
class MediaScreen extends StatefulWidget {
  const MediaScreen({super.key});

  @override
  State<MediaScreen> createState() => _MediaScreenState();
}

class _MediaScreenState extends State<MediaScreen> {
  final List<MediaItem> _media = [];
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
      final (list, total) = await AdminApi.media(page: _page);
      setState(() {
        if (refresh || _page == 1) _media.clear();
        _media.addAll(list);
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

  Future<void> _delete(MediaItem m) async {
    await AdminApi.deleteMedia(m.id);
    _load(refresh: true);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: _error != null && _media.isEmpty
              ? ErrorView(message: _error!, onRetry: () => _load(refresh: true))
              : ListView.builder(
                  itemCount: _media.length + (_loading ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i >= _media.length) return const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
                    final m = _media[i];
                    final isImage = (m.fileType ?? '').startsWith('image/');
                    return Card(
                      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                      child: ListTile(
                        leading: isImage
                            ? ClipRRect(
                                borderRadius: BorderRadius.circular(6),
                                child: Image.network(AppConfig.asset(m.filePath), width: 48, height: 48, fit: BoxFit.cover, errorBuilder: (c, u, e) => const Icon(Icons.image_outlined)),
                              )
                            : const Icon(Icons.insert_drive_file_outlined),
                        title: Text(m.originalName.isNotEmpty ? m.originalName : m.filename, maxLines: 1, overflow: TextOverflow.ellipsis),
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
        Padding(
          padding: const EdgeInsets.all(8),
          child: Text('共 $_total 个媒体文件', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
        ),
      ],
    );
  }
}
