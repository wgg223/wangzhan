import 'package:flutter/material.dart';

import '../../api/image_share_api.dart';
import '../../models/image_item.dart';
import '../../widgets/common.dart';
import '../../widgets/image_grid_card.dart';
import '../image_share/image_detail_screen.dart';

/// 我的收藏
class FavoritesScreen extends StatefulWidget {
  const FavoritesScreen({super.key});

  @override
  State<FavoritesScreen> createState() => _FavoritesScreenState();
}

class _FavoritesScreenState extends State<FavoritesScreen> {
  final List<ImageItem> _items = [];
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
      final list = await ImageShareApi.favorites(page: _page);
      setState(() {
        if (refresh || _page == 1) _items.clear();
        _items.addAll(list);
        _hasMore = list.length >= 20;
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('我的收藏')),
      body: RefreshIndicator(
        onRefresh: () => _load(refresh: true),
        child: _error != null && _items.isEmpty
            ? ListView(children: [Padding(padding: const EdgeInsets.only(top: 80), child: ErrorView(message: _error!, onRetry: () => _load(refresh: true)))])
            : GridView.builder(
                padding: const EdgeInsets.all(12),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, crossAxisSpacing: 8, mainAxisSpacing: 8, childAspectRatio: 0.85),
                itemCount: _items.length + (_hasMore ? 1 : 0),
                itemBuilder: (context, i) {
                  if (i >= _items.length) return const Center(child: CircularProgressIndicator(strokeWidth: 2));
                  return ImageGridCard(item: _items[i], onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ImageDetailScreen(imageId: _items[i].id))));
                },
              ),
      ),
    );
  }
}
