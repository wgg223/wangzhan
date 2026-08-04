import 'package:flutter/material.dart';

import '../api/api_client.dart';
import 'common.dart';

/// 通用分页列表：吸收页码/加载/错误/滚动加载状态机。
///
/// [futurePage] 返回 (列表, 总数)，组件内部按 [pageSize] 逐页加载，
/// 到底自动加载下一页，支持下拉刷新与错误重试。
class PagedListView<T> extends StatefulWidget {
  const PagedListView({
    super.key,
    required this.futurePage,
    required this.itemBuilder,
    this.pageSize = 10,
    this.emptyMessage = '暂无数据',
    this.footer,
    this.onRefresh,
    this.gridDelegate,
  });

  /// 加载第 page 页（从 1 开始），返回 (items, total)
  final Future<(List<T>, int)> Function(int page) futurePage;
  final Widget Function(BuildContext context, T item, int index) itemBuilder;
  final int pageSize;
  final String emptyMessage;

  /// 列表底部附加内容（如总数统计）
  final Widget? footer;

  /// 下拉刷新回调（返回 true 表示可下拉）
  final Future<void> Function()? onRefresh;

  /// 网格布局：非 null 时以 GridView 渲染（如图片管理）
  final SliverGridDelegate? gridDelegate;

  @override
  State<PagedListView<T>> createState() => _PagedListViewState<T>();
}

class _PagedListViewState<T> extends State<PagedListView<T>> {
  final List<T> _items = [];
  final _scroll = ScrollController();
  int _page = 1;
  bool _loading = false;
  bool _hasMore = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _load();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 200) {
      _load();
    }
  }

  Future<void> _load({bool refresh = false}) async {
    if (_loading) return;
    if (refresh) {
      _page = 1;
      _hasMore = true;
      setState(() => _error = null);
    }
    if (!_hasMore && !refresh) return;
    setState(() => _loading = true);
    try {
      final (list, _) = await widget.futurePage(_page);
      if (!mounted) return;
      setState(() {
        if (refresh || _page == 1) _items.clear();
        _items.addAll(list);
        _hasMore = list.length >= widget.pageSize;
        _page++;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = '网络错误，请检查连接');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null && _items.isEmpty) {
      return ErrorView(message: _error!, onRetry: () => _load(refresh: true));
    }
    final gridDelegate = widget.gridDelegate;
    final itemCount =
        _items.length + (_loading ? 1 : 0) + (widget.footer != null ? 1 : 0);
    final Widget scrollable;
    if (gridDelegate != null) {
      scrollable = GridView.builder(
        controller: _scroll,
        gridDelegate: gridDelegate,
        itemCount: itemCount,
        itemBuilder: (context, i) {
          if (i < _items.length) return widget.itemBuilder(context, _items[i], i);
          if (_loading) {
            return const Center(child: CircularProgressIndicator(strokeWidth: 2));
          }
          return widget.footer ?? const SizedBox.shrink();
        },
      );
    } else {
      scrollable = ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.only(bottom: 8),
        itemCount: itemCount,
        itemBuilder: (context, i) {
          if (i < _items.length) return widget.itemBuilder(context, _items[i], i);
          if (_loading) {
            return const Padding(
              padding: EdgeInsets.all(12),
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            );
          }
          return widget.footer ?? const SizedBox.shrink();
        },
      );
    }
    if (widget.onRefresh == null) return scrollable;
    return RefreshIndicator(onRefresh: widget.onRefresh!, child: scrollable);
  }
}
