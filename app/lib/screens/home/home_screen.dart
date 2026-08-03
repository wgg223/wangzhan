import 'package:flutter/material.dart';

import '../../api/article_api.dart';
import '../../models/article.dart';
import '../../widgets/article_card.dart';
import '../../widgets/common.dart';
import '../articles/article_detail_screen.dart';
import '../novels/novel_list_screen.dart';
import '../search/search_screen.dart';

/// 首页：搜索入口 + 功能入口 + 文章列表
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final List<Article> _articles = [];
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
      final list = await ArticleApi.list(page: _page, limit: 10);
      setState(() {
        if (refresh || _page == 1) {
          _articles.clear();
          _articles.addAll(list);
        } else {
          _articles.addAll(list);
        }
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
      appBar: AppBar(
        title: const Text('首页'),
        actions: [
          IconButton(icon: const Icon(Icons.search), onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SearchScreen()))),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _load(refresh: true),
        child: ListView(
          padding: const EdgeInsets.only(bottom: 16),
          children: [
            // 功能快捷入口
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
              child: Row(
                children: [
                  _QuickEntry(icon: Icons.photo_library, label: '图片分享', color: const Color(0xFF10B981), onTap: () {}),
                  const SizedBox(width: 8),
                  _QuickEntry(icon: Icons.menu_book, label: '小说', color: const Color(0xFFF59E0B), onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const NovelListScreen()))),
                  const SizedBox(width: 8),
                  _QuickEntry(icon: Icons.forum, label: '社区', color: const Color(0xFF6366F1), onTap: () {}),
                ],
              ),
            ),
            const SizedBox(height: 8),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: Text('最新文章', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            ),
            if (_error != null && _articles.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 40),
                child: ErrorView(message: _error!, onRetry: () => _load(refresh: true)),
              )
            else ...[
              ..._articles.map((a) => ArticleCard(
                    article: a,
                    onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ArticleDetailScreen(articleId: a.id))),
                  )),
              if (_loading)
                const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))
              else if (!_hasMore && _articles.isNotEmpty)
                Padding(padding: const EdgeInsets.all(16), child: Center(child: Text('没有更多了', style: TextStyle(color: Colors.grey.shade400)))),
            ],
          ],
        ),
      ),
    );
  }
}

class _QuickEntry extends StatelessWidget {
  const _QuickEntry({required this.icon, required this.label, required this.color, this.onTap});

  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(color: color.withOpacity(0.1), borderRadius: BorderRadius.circular(12)),
          child: Column(
            children: [
              Icon(icon, color: color, size: 26),
              const SizedBox(height: 6),
              Text(label, style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w500)),
            ],
          ),
        ),
      ),
    );
  }
}
