import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/admin_models.dart';
import '../../widgets/common.dart';

/// 仪表盘
class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  late Future<DashboardStats> _future;

  @override
  void initState() {
    super.initState();
    _future = AdminApi.dashboard();
  }

  @override
  Widget build(BuildContext context) {
    return FutureView(
      future: _future,
      reload: () => setState(() => _future = AdminApi.dashboard()),
      builder: (context, stats) {
        return RefreshIndicator(
          onRefresh: () async => setState(() => _future = AdminApi.dashboard()),
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _StatCard(icon: Icons.people_outline, label: '用户总数', value: stats.userCount, color: const Color(0xFF2563EB)),
              _StatCard(icon: Icons.article_outlined, label: '文章数', value: stats.articleCount, color: const Color(0xFF10B981)),
              _StatCard(icon: Icons.photo_library_outlined, label: '图片数', value: stats.imageCount, color: const Color(0xFFF59E0B)),
              _StatCard(icon: Icons.menu_book_outlined, label: '小说数', value: stats.novelCount, color: const Color(0xFF6366F1)),
              _StatCard(icon: Icons.comment_outlined, label: '评论数', value: stats.commentCount, color: const Color(0xFFEC4899)),
              _StatCard(icon: Icons.pending_actions, label: '待审核图片', value: stats.pendingImages, color: Colors.orange, highlight: stats.pendingImages > 0),
              _StatCard(icon: Icons.pending_actions, label: '待审核评论', value: stats.pendingComments, color: Colors.deepOrange, highlight: stats.pendingComments > 0),
              if (stats.uptime.isNotEmpty)
                _InfoRow(label: '运行时间', value: stats.uptime),
              if (stats.dbSize.isNotEmpty)
                _InfoRow(label: '数据库大小', value: stats.dbSize),
            ],
          ),
        );
      },
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({required this.icon, required this.label, required this.value, required this.color, this.highlight = false});

  final IconData icon;
  final String label;
  final int value;
  final Color color;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: CircleAvatar(backgroundColor: color.withOpacity(0.15), child: Icon(icon, color: color)),
        title: Text('$value', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        subtitle: Text(label),
        trailing: highlight ? const Icon(Icons.warning_amber, color: Colors.orange) : null,
      ),
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
