import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../config/app_config.dart';
import '../../models/image_item.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 图片管理（审核 / 删除 / 分类）
class ImagesAdminScreen extends StatefulWidget {
  const ImagesAdminScreen({super.key});

  @override
  State<ImagesAdminScreen> createState() => _ImagesAdminScreenState();
}

class _ImagesAdminScreenState extends State<ImagesAdminScreen> {
  final List<ImageItem> _images = [];
  int _page = 1;
  int _total = 0;
  bool _loading = false;
  String? _error;
  int? _statusFilter;

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
      final (list, total) = await AdminApi.images(page: _page, status: _statusFilter);
      setState(() {
        if (refresh || _page == 1) _images.clear();
        _images.addAll(list);
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

  Future<void> _approve(ImageItem img) async {
    await AdminApi.setImageStatus(img.id, 1);
    _load(refresh: true);
  }

  Future<void> _reject(ImageItem img) async {
    await AdminApi.setImageStatus(img.id, 0);
    _load(refresh: true);
  }

  Future<void> _delete(ImageItem img) async {
    await AdminApi.deleteImage(img.id);
    _load(refresh: true);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: SegmentedButton<int?>(
            segments: const [
              ButtonSegment(value: null, label: Text('全部')),
              ButtonSegment(value: 0, label: Text('待审核')),
              ButtonSegment(value: 1, label: Text('已通过')),
            ],
            selected: {_statusFilter},
            onSelectionChanged: (s) {
              setState(() => _statusFilter = s.first);
              _load(refresh: true);
            },
          ),
        ),
        Expanded(
          child: _error != null && _images.isEmpty
              ? ErrorView(message: _error!, onRetry: () => _load(refresh: true))
              : GridView.builder(
                  padding: const EdgeInsets.all(12),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2, crossAxisSpacing: 10, mainAxisSpacing: 10, childAspectRatio: 0.9),
                  itemCount: _images.length + (_loading ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i >= _images.length) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
                    final img = _images[i];
                    return Card(
                      clipBehavior: Clip.antiAlias,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Stack(
                              fit: StackFit.expand,
                              children: [
                                CachedNetworkImage(
                                  imageUrl: AppConfig.asset(img.url),
                                  fit: BoxFit.cover,
                                  placeholder: (c, u) => Container(color: Colors.grey.shade200),
                                  errorWidget: (c, u, e) => Container(color: Colors.grey.shade200, child: const Icon(Icons.broken_image_outlined)),
                                ),
                                if (img.status != 1)
                                  Positioned(
                                    top: 6,
                                    left: 6,
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                      decoration: BoxDecoration(color: Colors.orange, borderRadius: BorderRadius.circular(4)),
                                      child: const Text('待审核', style: TextStyle(color: Colors.white, fontSize: 11)),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          Padding(
                            padding: const EdgeInsets.all(8),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(img.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                                Text('${img.userName} · ${TimeFormat.from(img.createdAt)}', style: TextStyle(fontSize: 11, color: Colors.grey.shade500)),
                                const SizedBox(height: 6),
                                Row(
                                  children: [
                                    if (img.status != 1) ...[
                                      Expanded(child: FilledButton(onPressed: () => _approve(img), child: const Text('通过'))),
                                      const SizedBox(width: 6),
                                    ],
                                    Expanded(child: OutlinedButton(onPressed: () => _delete(img), child: const Text('删除'))),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Text('共 $_total 张图片', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
        ),
      ],
    );
  }
}
