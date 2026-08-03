import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/auth_api.dart';
import '../../api/image_share_api.dart';
import '../../api/message_api.dart';
import '../../models/image_item.dart';
import '../../models/user.dart';
import '../../state/auth_state.dart';
import '../../widgets/common.dart';
import '../admin/admin_shell.dart';
import '../auth/login_screen.dart';
import '../image_share/image_detail_screen.dart';
import '../messages/message_list_screen.dart';
import 'edit_profile_screen.dart';
import 'favorites_screen.dart';
import 'notifications_screen.dart';
import 'theme_settings_screen.dart';

/// 我的（个人中心）
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  int _unreadMessages = 0;

  @override
  void initState() {
    super.initState();
    _loadUnread();
  }

  Future<void> _loadUnread() async {
    try {
      final n = await MessageApi.unreadTotal();
      if (mounted) setState(() => _unreadMessages = n);
    } catch (_) {}
  }

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('确定要退出当前账号吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('退出')),
        ],
      ),
    );
    if (ok == true && mounted) {
      await context.read<AuthState>().logout();
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final user = auth.user;
    if (user == null) return const SizedBox.shrink();

    return Scaffold(
      appBar: AppBar(title: const Text('我的')),
      body: ListView(
        children: [
          // 用户信息卡片
          Container(
            padding: const EdgeInsets.all(20),
            color: Theme.of(context).cardColor,
            child: Row(
              children: [
                CircleAvatar(radius: 32, backgroundColor: const Color(0xFF2563EB).withOpacity(0.15), child: Text(user.displayName.isNotEmpty ? user.displayName[0] : '?', style: const TextStyle(fontSize: 22, color: Color(0xFF2563EB)))),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(user.displayName, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 4),
                      Text('@${user.username}', style: TextStyle(fontSize: 13, color: Colors.grey.shade500)),
                      if (user.bio.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(user.bio, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: Colors.grey.shade600)),
                      ],
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          _Stat(label: '文章', value: user.articleCount),
                          _Stat(label: '粉丝', value: user.followerCount),
                          _Stat(label: '关注', value: user.followingCount),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          _MenuGroup([
            _MenuItem(icon: Icons.favorite_outline, title: '我的收藏', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const FavoritesScreen()))),
            _MenuItem(icon: Icons.notifications_outlined, title: '通知', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const NotificationsScreen()))),
            _MenuItem(icon: Icons.chat_bubble_outline, title: '私信', badge: _unreadMessages, onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const MessageListScreen()))),
          ]),
          const SizedBox(height: 12),
          _MenuGroup([
            _MenuItem(icon: Icons.person_outline, title: '编辑资料', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const EditProfileScreen()))),
            _MenuItem(icon: Icons.palette_outlined, title: '主题设置', onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ThemeSettingsScreen()))),
          ]),
          if (user.isAdmin) ...[
            const SizedBox(height: 12),
            _MenuGroup([
              _MenuItem(
                icon: Icons.admin_panel_settings_outlined,
                title: '管理后台',
                highlight: true,
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AdminShell())),
              ),
            ]),
          ],
          const SizedBox(height: 12),
          _MenuGroup([
            _MenuItem(icon: Icons.logout, title: '退出登录', onTap: _logout),
          ]),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('$value', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          Text(label, style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
        ],
      ),
    );
  }
}

class _MenuGroup extends StatelessWidget {
  const _MenuGroup(this.items);

  final List<_MenuItem> items;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Theme.of(context).cardColor,
      child: Column(children: [for (var i = 0; i < items.length; i++) ...[
        items[i],
        if (i < items.length - 1) const Divider(height: 1, indent: 56),
      ]]),
    );
  }
}

class _MenuItem extends StatelessWidget {
  const _MenuItem({required this.icon, required this.title, this.onTap, this.badge = 0, this.highlight = false});

  final IconData icon;
  final String title;
  final VoidCallback? onTap;
  final int badge;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon, color: highlight ? const Color(0xFF2563EB) : null),
      title: Text(title, style: highlight ? const TextStyle(color: Color(0xFF2563EB), fontWeight: FontWeight.w600) : null),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (badge > 0)
            Container(
              margin: const EdgeInsets.only(right: 8),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: const BoxDecoration(color: Colors.red, borderRadius: BorderRadius.all(Radius.circular(10))),
              child: Text('$badge', style: const TextStyle(color: Colors.white, fontSize: 11)),
            ),
          const Icon(Icons.chevron_right, size: 20),
        ],
      ),
      onTap: onTap,
    );
  }
}
