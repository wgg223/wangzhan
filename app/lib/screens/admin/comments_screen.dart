import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 评论管理
class CommentsScreen extends StatefulWidget {
  const CommentsScreen({super.key});

  @override
  State<CommentsScreen> createState() => _CommentsScreenState();
}

class _CommentsScreenState extends State<CommentsScreen> {
  List<Map<String, dynamic>> _comments = [];
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
      final (list, total) = await AdminApi.comments(page: _page);
      setState(() {
        if (refresh || _page == 1) _comments.clear();
        _comments.addAll(list);
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

  Future<void> _delete(int id) async {
    await AdminApi.deleteComment(id);
    _load(refresh: true);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: _error != null && _comments.isEmpty
              ? ErrorView(message: _error!, onRetry: () => _load(refresh: true))
              : ListView.builder(
                  itemCount: _comments.length + (_loading ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i >= _comments.length) return const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
                    final c = _comments[i];
                    return Card(
                      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                      child: ListTile(
                        leading: CircleAvatar(child: Text((c['username']?.toString() ?? '?').isNotEmpty ? c['username'].toString()[0] : '?')),
                        title: Text(c['content']?.toString() ?? '', maxLines: 2, overflow: TextOverflow.ellipsis),
                        subtitle: Text('${c['username']} · ${TimeFormat.from(c['created_at']?.toString())} · ${c['status']}'),
                        trailing: IconButton(
                          icon: const Icon(Icons.delete_outline, color: Colors.red),
                          onPressed: () => _delete(c['id'] is int ? c['id'] : int.parse('${c['id']}')),
                        ),
                      ),
                    );
                  },
                ),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Text('共 $_total 条评论', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
        ),
      ],
    );
  }
}
