import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/admin_models.dart';
import '../../widgets/common.dart';

/// 服务器维护（系统信息 + 维护模式）
class MaintenanceScreen extends StatefulWidget {
  const MaintenanceScreen({super.key});

  @override
  State<MaintenanceScreen> createState() => _MaintenanceScreenState();
}

class _MaintenanceScreenState extends State<MaintenanceScreen> {
  late Future<SystemInfo> _future;
  bool _maintenanceOn = false;
  bool _toggling = false;
  final _title = TextEditingController();
  final _message = TextEditingController();

  @override
  void initState() {
    super.initState();
    _future = AdminApi.systemInfo();
  }

  Future<void> _toggleMaintenance() async {
    setState(() => _toggling = true);
    try {
      await AdminApi.toggleMaintenance(
        !_maintenanceOn,
        title: _title.text.trim(),
        message: _message.text.trim(),
      );
      setState(() => _maintenanceOn = !_maintenanceOn);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_maintenanceOn ? '维护模式已开启' : '维护模式已关闭')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
    } finally {
      if (mounted) setState(() => _toggling = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('维护模式', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
        const SizedBox(height: 8),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(_maintenanceOn ? '维护模式：开启' : '维护模式：关闭'),
          subtitle: const Text('开启后前端显示维护页面，管理后台不受影响'),
          value: _maintenanceOn,
          onChanged: _toggling ? null : (_) => _toggleMaintenance(),
        ),
        TextField(controller: _title, decoration: const InputDecoration(labelText: '维护标题（可选）')),
        const SizedBox(height: 12),
        TextField(controller: _message, maxLines: 2, decoration: const InputDecoration(labelText: '维护消息（可选）')),
        const Divider(height: 40),
        const Text('系统信息', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
        const SizedBox(height: 12),
        FutureView(
          future: _future,
          reload: () => setState(() => _future = AdminApi.systemInfo()),
          builder: (context, info) {
            return Column(
              children: [
                _InfoRow(label: '平台', value: info.platform),
                _InfoRow(label: 'Node 版本', value: info.nodeVersion),
                _InfoRow(label: '运行时间', value: info.uptime),
                _InfoRow(label: '内存', value: info.memory),
                _InfoRow(label: 'CPU', value: info.cpu),
                _InfoRow(label: '数据库大小', value: info.dbSize),
                _InfoRow(label: '数据表数量', value: '${info.dbTables}'),
                _InfoRow(label: '上传文件大小', value: info.uploadSize),
                _InfoRow(label: '备份大小', value: info.backupSize),
                _InfoRow(label: '缓存命中率', value: info.cacheHitRate),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: TextStyle(color: Colors.grey.shade600)),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }
}
