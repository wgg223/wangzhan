import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../config/app_config.dart';
import '../../models/image_item.dart';
import '../../utils/time_format.dart';
import '../../widgets/cached_image.dart';
import '../../widgets/paged_list_view.dart';

/// 图片管理（审核 / 删除 / 分类）
class ImagesAdminScreen extends StatefulWidget {
  const ImagesAdminScreen({super.key});

  @override
  State<ImagesAdminScreen> createState() => _ImagesAdminScreenState();
}

class _ImagesAdminScreenState extends State<ImagesAdminScreen> {
  int? _statusFilter;

  Future<(List<ImageItem>, int)> _fetch(int page) {
    return AdminApi.images(page: page, status: _statusFilter);
  }

  Future<void> _approve(ImageItem img) async {
    await AdminApi.setImageStatus(img.id, 1);
    if (mounted) setState(() {});
  }

  Future<void> _reject(ImageItem img) async {
    await AdminApi.setImageStatus(img.id, 0);
    if (mounted) setState(() {});
  }

  Future<void> _delete(ImageItem img) async {
    await AdminApi.deleteImage(img.id);
    if (mounted) setState(() {});
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
            },
          ),
        ),
        Expanded(
          child: PagedListView<ImageItem>(
            futurePage: _fetch,
            pageSize: 10,
            emptyMessage: '暂无图片',
            onRefresh: () async => setState(() {}),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              crossAxisSpacing: 10,
              mainAxisSpacing: 10,
              childAspectRatio: 0.9,
            ),
            itemBuilder: (context, img, _) {
              return Card(
                clipBehavior: Clip.antiAlias,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          CachedImage(url: AppConfig.asset(img.url)),
                          if (img.status != 1)
                            Positioned(
                              top: 6,
                              left: 6,
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                    color: Colors.orange, borderRadius: BorderRadius.circular(4)),
                                child: const Text('待审核',
                                    style: TextStyle(color: Colors.white, fontSize: 11)),
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
                          Text(img.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                          Text('${img.userName} · ${TimeFormat.from(img.createdAt)}',
                              style: TextStyle(fontSize: 11, color: Colors.grey.shade500)),
                          const SizedBox(height: 6),
                          Row(
                            children: [
                              if (img.status != 1) ...[
                                Expanded(
                                  child: FilledButton(
                                      onPressed: () => _approve(img), child: const Text('通过')),
                                ),
                                const SizedBox(width: 6),
                              ],
                              if (img.status == 1) ...[
                                Expanded(
                                  child: OutlinedButton(
                                      onPressed: () => _reject(img), child: const Text('驳回')),
                                ),
                                const SizedBox(width: 6),
                              ],
                              Expanded(
                                child: OutlinedButton(
                                    onPressed: () => _delete(img), child: const Text('删除')),
                              ),
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
      ],
    );
  }
}
