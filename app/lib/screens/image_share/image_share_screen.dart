import 'package:flutter/material.dart';

import '../../api/image_share_api.dart';
import '../../models/image_item.dart';
import '../../widgets/common.dart';
import '../../widgets/image_grid_card.dart';
import 'image_detail_screen.dart';
import 'image_upload_screen.dart';

/// 图片分享页：分类 + 网格
class ImageShareScreen extends StatefulWidget {
  const ImageShareScreen({super.key});

  @override
  State<ImageShareScreen> createState() => _ImageShareScreenState();
}

class _ImageShareScreenState extends State<ImageShareScreen> {
  final List<ImageCategory> _categories = [];
  final List<ImageItem> _images = [];
  int? _selectedCategory;
  int _page = 1;
  bool _loading = false;
  bool _hasMore = true;
  String? _error;
  bool _initLoaded = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      final cats = await ImageShareApi.categories();
      if (mounted) setState(() => _categories.addAll(cats));
    } catch (_) {}
    _loadImages(refresh: true);
    _initLoaded = true;
  }

  Future<void> _loadImages({bool refresh = false}) async {
    if (_loading) return;
    if (refresh) {
      _page = 1;
      _hasMore = true;
      setState(() => _error = null);
    }
    if (!_hasMore) return;
    setState(() => _loading = true);
    try {
      final list = await ImageShareApi.list(page: _page, limit: 20, categoryId: _selectedCategory);
      setState(() {
        if (refresh || _page == 1) {
          _images.clear();
        }
        _images.addAll(list);
        _hasMore = list.length >= 20;
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('图片分享'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add_photo_alternate_outlined),
            tooltip: '上传图片',
            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ImageUploadScreen())).then((v) {
              if (v == true) _loadImages(refresh: true);
            }),
          ),
        ],
      ),
      body: Column(
        children: [
          // 分类横滑
          if (_categories.isNotEmpty)
            SizedBox(
              height: 44,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                children: [
                  _CategoryChip(label: '全部', selected: _selectedCategory == null, onTap: () => setState(() {
                    _selectedCategory = null;
                    _loadImages(refresh: true);
                  })),
                  ..._categories.map((c) => _CategoryChip(
                        label: c.name,
                        selected: _selectedCategory == c.id,
                        onTap: () => setState(() {
                          _selectedCategory = c.id;
                          _loadImages(refresh: true);
                        }),
                      )),
                ],
              ),
            ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () => _loadImages(refresh: true),
              child: _error != null && _images.isEmpty
                  ? ListView(children: [Padding(padding: const EdgeInsets.only(top: 80), child: ErrorView(message: _error!, onRetry: () => _loadImages(refresh: true)))])
                  : GridView.builder(
                      padding: const EdgeInsets.all(12),
                      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: 3,
                        crossAxisSpacing: 8,
                        mainAxisSpacing: 8,
                        childAspectRatio: 0.85,
                      ),
                      itemCount: _images.length + (_hasMore ? 1 : 0),
                      itemBuilder: (context, i) {
                        if (i >= _images.length) {
                          return const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(strokeWidth: 2)));
                        }
                        final item = _images[i];
                        return ImageGridCard(
                          item: item,
                          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ImageDetailScreen(imageId: item.id))),
                        );
                      },
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CategoryChip extends StatelessWidget {
  const _CategoryChip({required this.label, required this.selected, this.onTap});

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: selected,
        onSelected: (_) => onTap?.call(),
        showCheckmark: false,
      ),
    );
  }
}
