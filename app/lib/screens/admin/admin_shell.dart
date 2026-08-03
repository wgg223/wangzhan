import 'package:flutter/material.dart';

import 'articles_admin_screen.dart';
import 'backup_screen.dart';
import 'comments_screen.dart';
import 'dashboard_screen.dart';
import 'images_admin_screen.dart';
import 'logs_screen.dart';
import 'maintenance_screen.dart';
import 'media_screen.dart';
import 'novels_admin_screen.dart';
import 'permissions_screen.dart';
import 'settings_screen.dart';
import 'users_screen.dart';

/// 管理后台外壳（抽屉导航）
class AdminShell extends StatefulWidget {
  const AdminShell({super.key});

  @override
  State<AdminShell> createState() => _AdminShellState();
}

class _AdminShellState extends State<AdminShell> {
  int _index = 0;

  static const _titles = [
    '仪表盘', '用户管理', '文章管理', '评论管理', '图片管理',
    '小说管理', '系统设置', '操作日志', '权限管理', '媒体管理',
    '备份管理', '服务器维护',
  ];

  static const _icons = [
    Icons.dashboard_outlined, Icons.people_outline, Icons.article_outlined, Icons.comment_outlined, Icons.photo_library_outlined,
    Icons.menu_book_outlined, Icons.settings_outlined, Icons.receipt_long_outlined, Icons.shield_outlined, Icons.folder_outlined,
    Icons.backup_outlined, Icons.build_outlined,
  ];

  late final List<Widget> _pages = [
    const DashboardScreen(),
    const UsersScreen(),
    const ArticlesAdminScreen(),
    const CommentsScreen(),
    const ImagesAdminScreen(),
    const NovelsAdminScreen(),
    const SettingsScreen(),
    const LogsScreen(),
    const PermissionsScreen(),
    const MediaScreen(),
    const BackupScreen(),
    const MaintenanceScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[_index]),
        leading: Builder(
          builder: (ctx) => IconButton(
            icon: const Icon(Icons.menu),
            onPressed: () => Scaffold.of(ctx).openDrawer(),
          ),
        ),
      ),
      drawer: Drawer(
        child: SafeArea(
          child: ListView(
            padding: EdgeInsets.zero,
            children: [
              const Padding(
                padding: EdgeInsets.all(16),
                child: Row(
                  children: [
                    Icon(Icons.admin_panel_settings, color: Color(0xFF2563EB), size: 28),
                    SizedBox(width: 10),
                    Text('管理后台', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  ],
                ),
              ),
              const Divider(height: 1),
              for (var i = 0; i < _titles.length; i++)
                ListTile(
                  leading: Icon(_icons[i], color: i == _index ? const Color(0xFF2563EB) : null),
                  title: Text(_titles[i], style: i == _index ? const TextStyle(color: Color(0xFF2563EB), fontWeight: FontWeight.w600) : null),
                  selected: i == _index,
                  onTap: () {
                    setState(() => _index = i);
                    Navigator.pop(context);
                  },
                ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.home_outlined),
                title: const Text('返回主页'),
                onTap: () => Navigator.of(context).popUntil((route) => route.isFirst),
              ),
            ],
          ),
        ),
      ),
      body: IndexedStack(index: _index, children: _pages),
    );
  }
}
