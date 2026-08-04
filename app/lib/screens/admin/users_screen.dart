import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/admin_api.dart';
import '../../models/user.dart';
import '../../state/auth_state.dart';
import '../../utils/time_format.dart';
import '../../widgets/paged_list_view.dart';

/// 用户管理（对齐 Web 端：状态/角色徽章、操作按钮组、创建用户弹窗；
/// 非超管只读，操作按钮仅超管可见，服务端同时强制校验）
class UsersScreen extends StatefulWidget {
  const UsersScreen({super.key});

  @override
  State<UsersScreen> createState() => _UsersScreenState();
}

class _UsersScreenState extends State<UsersScreen> {
  final _search = TextEditingController();
  String? _roleFilter;
  final _pagedKey = GlobalKey();

  Future<(List<User>, int)> _fetch(int page) {
    return AdminApi.users(
      page: page,
      q: _search.text.trim(),
      role: _roleFilter,
    );
  }

  void _reload() {
    setState(() {});
  }

  Future<void> _confirm(String title, String message, Future<void> Function() action) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确认')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await action();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('操作成功')));
        _reload();
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('操作失败')));
      }
    }
  }

  Future<void> _toggleStatus(User u) async {
    final target = u.status == 'active' ? 'disabled' : 'active';
    final label = target == 'active' ? '启用' : '禁用';
    await _confirm(
      '$label用户',
      '确定要${label}「${u.displayName}」吗？',
      () => AdminApi.updateUserStatus(u.id, target),
    );
  }

  Future<void> _changeRole(User u) async {
    final role = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: Text('修改「${u.displayName}」的角色'),
        children: [
          for (final r in ['user', 'admin', 'super_admin'])
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, r),
              child: Text('${_roleLabel(r)}${u.role == r ? '（当前）' : ''}'),
            ),
        ],
      ),
    );
    if (role == null || role == u.role) return;
    await _confirm('修改角色', '确定将「${u.displayName}」改为${_roleLabel(role)}吗？',
        () => AdminApi.updateUserRole(u.id, role));
  }

  Future<void> _resetPassword(User u) async {
    try {
      final newPw = await AdminApi.resetPassword(u.id);
      if (mounted) {
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('重置密码成功'),
            content: Text('用户「${u.displayName}」的新密码：\n\n$newPw\n\n请妥善保存并告知用户。'),
            actions: [
              FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('知道了')),
            ],
          ),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  Future<void> _deleteUser(User u) async {
    await _confirm('删除用户', '确定要删除「${u.displayName}」吗？此操作不可恢复。',
        () => AdminApi.deleteUser(u.id));
  }

  Future<void> _createUser() async {
    final username = TextEditingController();
    final email = TextEditingController();
    final password = TextEditingController();
    String role = 'user';

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('创建用户'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: username, decoration: const InputDecoration(labelText: '用户名（至少3个字符）')),
              const SizedBox(height: 8),
              TextField(controller: email, decoration: const InputDecoration(labelText: '邮箱（选填）')),
              const SizedBox(height: 8),
              TextField(controller: password, obscureText: true, decoration: const InputDecoration(labelText: '密码（至少6位）')),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: role,
                decoration: const InputDecoration(labelText: '角色'),
                items: [
                  for (final r in ['user', 'admin', 'visitor'])
                    DropdownMenuItem(value: r, child: Text(_roleLabel(r))),
                ],
                onChanged: (v) => setDialogState(() => role = v ?? 'user'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('创建'),
            ),
          ],
        ),
      ),
    );
    if (ok != true) return;
    try {
      await AdminApi.createUser(
        username: username.text.trim(),
        email: email.text.trim(),
        password: password.text,
        role: role,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('账户创建成功')));
        _reload();
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  static String _roleLabel(String role) => switch (role) {
        'super_admin' => '超级管理员',
        'admin' => '管理员',
        'user' => '用户',
        'visitor' => '访客',
        _ => role,
      };

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final isSuper = auth.user?.isSuperAdmin ?? false;
    final currentId = auth.user?.id;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _search,
                  decoration: const InputDecoration(hintText: '搜索用户名', isDense: true),
                  onSubmitted: (_) => _reload(),
                ),
              ),
              const SizedBox(width: 8),
              DropdownButton<String>(
                value: _roleFilter ?? 'all',
                items: const [
                  DropdownMenuItem(value: 'all', child: Text('全部角色')),
                  DropdownMenuItem(value: 'admin', child: Text('管理员')),
                  DropdownMenuItem(value: 'user', child: Text('普通用户')),
                  DropdownMenuItem(value: 'super_admin', child: Text('超级管理员')),
                ],
                onChanged: (v) {
                  setState(() => _roleFilter = (v == 'all') ? null : v);
                  _reload();
                },
              ),
            ],
          ),
        ),
        if (!isSuper)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 12),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('只读模式：仅可查看。添加、禁用、删除、改角色等操作仅超级管理员可用。',
                  style: TextStyle(fontSize: 12, color: Colors.orange)),
            ),
          ),
        Expanded(
          child: PagedListView<User>(
            key: _pagedKey,
            futurePage: _fetch,
            pageSize: 10,
            emptyMessage: '暂无用户',
            onRefresh: () async => _reload(),
            itemBuilder: (context, u, _) {
              final isSelf = u.id == currentId;
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: ListTile(
                  leading: CircleAvatar(child: Text(u.displayName.isNotEmpty ? u.displayName[0] : '?')),
                  title: Row(
                    children: [
                      Flexible(child: Text(u.displayName, overflow: TextOverflow.ellipsis)),
                      const SizedBox(width: 6),
                      _RoleBadge(role: u.role),
                      if (u.status != 'active') ...[
                        const SizedBox(width: 6),
                        _StatusBadge(status: u.status),
                      ],
                      if (isSelf) ...[
                        const SizedBox(width: 6),
                        const Text('（当前登录）',
                            style: TextStyle(fontSize: 11, fontStyle: FontStyle.italic, color: Colors.grey)),
                      ],
                    ],
                  ),
                  subtitle: Text('@${u.username} · ${TimeFormat.from(u.createdAt)}'),
                  trailing: isSelf || !isSuper
                      ? null
                      : Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconButton(
                              tooltip: u.status == 'active' ? '禁用' : '启用',
                              icon: Icon(
                                u.status == 'active' ? Icons.block : Icons.check_circle_outline,
                                color: u.status == 'active' ? Colors.orange : Colors.green,
                                size: 20,
                              ),
                              onPressed: () => _toggleStatus(u),
                            ),
                            IconButton(
                              tooltip: '改角色',
                              icon: const Icon(Icons.manage_accounts_outlined, size: 20),
                              onPressed: () => _changeRole(u),
                            ),
                            IconButton(
                              tooltip: '重置密码',
                              icon: const Icon(Icons.password, size: 20),
                              onPressed: () => _resetPassword(u),
                            ),
                            IconButton(
                              tooltip: '删除',
                              icon: const Icon(Icons.delete_outline, color: Colors.red, size: 20),
                              onPressed: () => _deleteUser(u),
                            ),
                          ],
                        ),
                ),
              );
            },
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                const Spacer(),
                if (isSuper)
                  FilledButton.icon(
                    onPressed: _createUser,
                    icon: const Icon(Icons.person_add_alt, size: 18),
                    label: const Text('添加用户'),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _RoleBadge extends StatelessWidget {
  const _RoleBadge({required this.role});

  final String role;

  @override
  Widget build(BuildContext context) {
    final (label, bg, fg) = switch (role) {
      'super_admin' => ('超管', const Color(0xFFFEF3C7), const Color(0xFF92400E)),
      'admin' => ('管理员', const Color(0xFFDBEAFE), const Color(0xFF1D4ED8)),
      'visitor' => ('访客', const Color(0xFFF3F4F6), const Color(0xFF4B5563)),
      _ => ('用户', const Color(0xFFD1FAE5), const Color(0xFF065F46)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(4)),
      child: Text(label, style: TextStyle(fontSize: 10, color: fg, fontWeight: FontWeight.w600)),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final (label, bg, fg) = status == 'disabled'
        ? ('已禁用', const Color(0xFFFEE2E2), const Color(0xFF991B1B))
        : ('待审核', const Color(0xFFFEF3C7), const Color(0xFF92400E));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(4)),
      child: Text(label, style: TextStyle(fontSize: 10, color: fg, fontWeight: FontWeight.w600)),
    );
  }
}
