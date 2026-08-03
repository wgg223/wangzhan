import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/admin_models.dart';
import '../../utils/time_format.dart';
import '../../widgets/common.dart';

/// 备份管理
class BackupScreen extends StatefulWidget {
  const BackupScreen({super.key});

  @override
  State<BackupScreen> createState() => _BackupScreenState();
}

class _BackupScreenState extends State<BackupScreen> {
  late Future<List<BackupItem>> _future;
  bool _creating = false;

  @override
  void initState() {
    super.initState();
    _future = AdminApi.backups();
  }

  Future<void> _create(String type) async {
    setState(() => _creating = true);
    try {
      await AdminApi.createBackup(type);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('备份任务已提交')));
        setState(() => _future = AdminApi.backups());
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('备份失败：$e')));
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  Future<void> _delete(String name) async {
    await AdminApi.deleteBackup(name);
    setState(() => _future = AdminApi.backups());
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _creating ? null : () => _create('full'),
                  icon: const Icon(Icons.backup_outlined, size: 18),
                  label: const Text('完整备份'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _creating ? null : () => _create('database'),
                  icon: const Icon(Icons.storage_outlined, size: 18),
                  label: const Text('仅数据库'),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: FutureView(
            future: _future,
            reload: () => setState(() => _future = AdminApi.backups()),
            builder: (context, list) {
              if (list.isEmpty) return const EmptyView(message: '暂无备份', icon: Icons.backup_outlined);
              return ListView.builder(
                itemCount: list.length,
                itemBuilder: (context, i) {
                  final b = list[i];
                  return ListTile(
                    leading: const Icon(Icons.archive_outlined),
                    title: Text(b.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${b.type} · ${b.size >= 1024 * 1024 ? '${(b.size / 1024 / 1024).toStringAsFixed(1)} MB' : '${(b.size / 1024).toStringAsFixed(0)} KB'} · ${TimeFormat.from(b.createdAt)}'),
                    trailing: IconButton(
                      icon: const Icon(Icons.delete_outline, color: Colors.red),
                      onPressed: () => _delete(b.name),
                    ),
                  );
                },
              );
            },
          ),
        ),
      ],
    );
  }
}
