import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/admin_models.dart';
import '../../utils/time_format.dart';
import '../../widgets/paged_list_view.dart';

/// 操作日志
class LogsScreen extends StatefulWidget {
  const LogsScreen({super.key});

  @override
  State<LogsScreen> createState() => _LogsScreenState();
}

class _LogsScreenState extends State<LogsScreen> {
  Future<(List<AdminLog>, int)> _fetch(int page) {
    return AdminApi.logs(page: page);
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
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('日志已清理')));
        setState(() {});
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: PagedListView<AdminLog>(
            futurePage: _fetch,
            pageSize: 20,
            emptyMessage: '暂无日志',
            onRefresh: () async => setState(() {}),
            itemBuilder: (context, log, _) {
              return ListTile(
                dense: true,
                leading: CircleAvatar(
                  radius: 14,
                  child: Text(log.username.isNotEmpty ? log.username[0] : '?',
                      style: const TextStyle(fontSize: 12)),
                ),
                title: Text('${log.username} · ${log.action}', style: const TextStyle(fontSize: 14)),
                subtitle: Text('${log.targetType} ${log.targetTitle} · ${TimeFormat.from(log.createdAt)}',
                    style: const TextStyle(fontSize: 12)),
                trailing: log.ip.isNotEmpty
                    ? Text(log.ip, style: TextStyle(fontSize: 11, color: Colors.grey.shade400))
                    : null,
              );
            },
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                const Spacer(),
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
