import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/admin_models.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 操作日志
class LogsScreen extends StatefulWidget {
  const LogsScreen({super.key});

  @override
  State<LogsScreen> createState() => _LogsScreenState();
}

class _LogsScreenState extends State<LogsScreen> {
  final List<AdminLog> _logs = [];
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
      final (list, total) = await AdminApi.logs(page: _page);
      setState(() {
        if (refresh || _page == 1) _logs.clear();
        _logs.addAll(list);
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

  Future<void> _clear() async {
    final days = await showDialog<int>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('清理日志'),
        children: [
          for (final d in [7, 30, 90, 180])
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, d),
              child: Text('清理 $d 天前的日志'),
            ),
        ],
      ),
    );
    if (days != null) {
      await AdminApi.clearLogs(days);
      _load(refresh: true);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('日志已清理')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: _error != null && _logs.isEmpty
              ? ErrorView(message: _error!, onRetry: () => _load(refresh: true))
              : ListView.builder(
                  itemCount: _logs.length + (_loading ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i >= _logs.length) return const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
                    final log = _logs[i];
                    return ListTile(
                      dense: true,
                      leading: CircleAvatar(radius: 14, child: Text(log.username.isNotEmpty ? log.username[0] : '?', style: const TextStyle(fontSize: 12))),
                      title: Text('${log.username} · ${log.action}', style: const TextStyle(fontSize: 14)),
                      subtitle: Text('${log.targetType} ${log.targetTitle} · ${TimeFormat.from(log.createdAt)}', style: const TextStyle(fontSize: 12)),
                      trailing: log.ip.isNotEmpty ? Text(log.ip, style: TextStyle(fontSize: 11, color: Colors.grey.shade400)) : null,
                    );
                  },
                ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: Text('共 $_total 条日志', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                ),
                OutlinedButton.icon(
                  onPressed: _clear,
                  icon: const Icon(Icons.cleaning_services_outlined, size: 18),
                  label: const Text('清理日志'),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
