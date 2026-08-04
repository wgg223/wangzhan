import 'package:flutter/material.dart';

import '../../api/novel_api.dart';
import '../../config/app_config.dart';
import '../../models/novel.dart';
import '../../widgets/cached_image.dart';
import '../../widgets/common.dart';
import 'novel_detail_screen.dart';

/// 小说列表页
class NovelListScreen extends StatefulWidget {
  const NovelListScreen({super.key});

  @override
  State<NovelListScreen> createState() => _NovelListScreenState();
}

class _NovelListScreenState extends State<NovelListScreen> {
  final List<Novel> _novels = [];
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
      final list = await NovelApi.list(page: _page, limit: 10);
      setState(() {
        if (refresh || _page == 1) _novels.clear();
        _novels.addAll(list);
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('小说')),
      body: RefreshIndicator(
        onRefresh: () => _load(refresh: true),
        child: _error != null && _novels.isEmpty
            ? ListView(children: [Padding(padding: const EdgeInsets.only(top: 80), child: ErrorView(message: _error!, onRetry: () => _load(refresh: true)))])
            : ListView.builder(
                itemCount: _novels.length + (_hasMore ? 1 : 0),
                itemBuilder: (context, i) {
                  if (i >= _novels.length) {
                    return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
                  }
                  final novel = _novels[i];
                  return Card(
                    margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => NovelDetailScreen(novelId: novel.id))),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(
                          children: [
                            if (novel.cover.isNotEmpty) ...[
                              CachedImage(
                                url: AppConfig.asset(novel.cover),
                                width: 64,
                                height: 84,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              const SizedBox(width: 12),
                            ],
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(novel.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                                  const SizedBox(height: 4),
                                  Text('作者：${novel.author}', style: TextStyle(fontSize: 13, color: Colors.grey.shade600)),
                                  const SizedBox(height: 4),
                                  Text(novel.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                                  const SizedBox(height: 6),
                                  Text('${novel.chapterCount} 章', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
      ),
    );
  }
}
