import 'package:flutter/material.dart';

import '../../api/article_api.dart';
import '../../api/image_share_api.dart';
import '../../models/article.dart';
import '../../models/image_item.dart';
import '../../widgets/article_card.dart';
import '../../widgets/common.dart';
import '../../widgets/image_grid_card.dart';
import '../articles/article_detail_screen.dart';
import '../image_share/image_detail_screen.dart';

/// 搜索页（文章 + 图片）
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key});

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _controller = TextEditingController();
  int _tab = 0; // 0 文章, 1 图片
  List<Article> _articles = [];
  List<ImageItem> _images = [];
  bool _searching = false;
  String? _error;

  Future<void> _search() async {
    final q = _controller.text.trim();
    if (q.isEmpty) return;
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      if (_tab == 0) {
        final list = await ArticleApi.list(q: q, limit: 20);
        setState(() => _articles = list);
      } else {
        final list = await ImageShareApi.list(q: q, limit: 20);
        setState(() => _images = list);
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = '网络错误');
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: TextField(
          controller: _controller,
          autofocus: true,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(hintText: '搜索文章、图片...', border: InputBorder.none),
          onSubmitted: (_) => _search(),
        ),
        actions: [IconButton(onPressed: _search, icon: const Icon(Icons.search))],
      ),
      body: Column(
        children: [
          TabBar(
            tabs: const [Tab(text: '文章'), Tab(text: '图片')],
            onTap: (i) => setState(() => _tab = i),
          ),
          Expanded(
            child: _searching
                ? const LoadingView()
                : _error != null
                    ? ErrorView(message: _error!, onRetry: _search)
                    : _tab == 0
                        ? (_articles.isEmpty
                            ? const EmptyView(message: '输入关键词搜索文章')
                            : ListView(children: _articles.map((a) => ArticleCard(article: a, onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ArticleDetailScreen(articleId: a.id))))).toList()))
                        : (_images.isEmpty
                            ? const EmptyView(message: '输入关键词搜索图片')
                            : GridView.builder(
                                padding: const EdgeInsets.all(12),
                                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 3, crossAxisSpacing: 8, mainAxisSpacing: 8, childAspectRatio: 0.85),
                                itemCount: _images.length,
                                itemBuilder: (c, i) => ImageGridCard(item: _images[i], onTap: () => Navigator.push(c, MaterialPageRoute(builder: (_) => ImageDetailScreen(imageId: _images[i].id)))),
                              )),
          ),
        ],
      ),
    );
  }
}
