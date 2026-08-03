import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/user.dart';
import '../../widgets/common.dart';

/// 用户管理
class UsersScreen extends StatefulWidget {
  const UsersScreen({super.key});

  @override
  State<UsersScreen> createState() => _UsersScreenState();
}

class _UsersScreenState extends State<UsersScreen> {
  final List<User> _users = [];
  final _search = TextEditingController();
  int _page = 1;
  int _total = 0;
  bool _loading = false;
  String? _error;
  String? _roleFilter;

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
      final (list, total) = await AdminApi.users(page: _page, q: _search.text.trim(), role: _roleFilter);
      setState(() {
        if (refresh || _page == 1) _users.clear();
        _users.addAll(list);
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

  Future<void> _toggleRole(User user) async {
    final newRole = user.role == 'admin' ? 'user' : 'admin';
    await AdminApi.updateUser(user.id, role: newRole);
    _load(refresh: true);
  }

  Future<void> _toggleStatus(User user) async {
    final newStatus = user.status == 'active' ? 'disabled' : 'active';
    await AdminApi.updateUser(user.id, status: newStatus);
    _load(refresh: true);
  }

  Future<void> _delete(User user) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除用户'),
        content: Text('确定删除用户 ${user.username} 吗？此操作不可恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok == true) {
      await AdminApi.deleteUser(user.id);
      _load(refresh: true);
    }
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
                child: TextField(
                  controller: _search,
                  decoration: const InputDecoration(hintText: '搜索用户名', isDense: true),
                  onSubmitted: (_) => _load(refresh: true),
                ),
              ),
              const SizedBox(width: 8),
              DropdownButton<String>(
                value: _roleFilter ?? 'all',
                items: const [
                  DropdownMenuItem(value: 'all', child: Text('全部角色')),
                  DropdownMenuItem(value: 'admin', child: Text('管理员')),
                  DropdownMenuItem(value: 'user', child: Text('普通用户')),
                ],
                onChanged: (v) {
                  setState(() => _roleFilter = (v == 'all') ? null : v);
                  _load(refresh: true);
                },
              ),
            ],
          ),
        ),
        Expanded(
          child: _error != null && _users.isEmpty
              ? ErrorView(message: _error!, onRetry: () => _load(refresh: true))
              : ListView.builder(
                  itemCount: _users.length + (_loading ? 1 : 0),
                  itemBuilder: (context, i) {
                    if (i >= _users.length) return const Padding(padding: EdgeInsets.all(12), child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
                    final u = _users[i];
                    return Card(
                      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                      child: ListTile(
                        leading: CircleAvatar(child: Text(u.displayName.isNotEmpty ? u.displayName[0] : '?')),
                        title: Row(
                          children: [
                            Flexible(child: Text(u.displayName, overflow: TextOverflow.ellipsis)),
                            if (u.isAdmin) ...[
                              const SizedBox(width: 6),
                              const Icon(Icons.admin_panel_settings, size: 16, color: Color(0xFF2563EB)),
                            ],
                          ],
                        ),
                        subtitle: Text('@${u.username} · ${u.status}'),
                        trailing: PopupMenuButton<String>(
                          onSelected: (v) {
                            if (v == 'role') _toggleRole(u);
                            if (v == 'status') _toggleStatus(u);
                            if (v == 'delete') _delete(u);
                          },
                          itemBuilder: (_) => [
                            PopupMenuItem(value: 'role', child: Text(u.isAdmin ? '取消管理员' : '设为管理员')),
                            PopupMenuItem(value: 'status', child: Text(u.status == 'active' ? '禁用账号' : '启用账号')),
                            const PopupMenuItem(value: 'delete', child: Text('删除', style: TextStyle(color: Colors.red))),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Text('共 $_total 个用户 · 第 $_page 页', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
        ),
      ],
    );
  }
}
