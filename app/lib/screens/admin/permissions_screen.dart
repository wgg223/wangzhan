import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/admin_api.dart';
import '../../models/admin_models.dart';
import '../../models/user.dart';
import '../../state/auth_state.dart';
import '../../widgets/common.dart';

/// 权限管理：用户列表 → 选择用户 → 权限按类别分组展示；
/// 撤销矩阵（勾选已拥有权限 → 确认 → 批量撤销）；
/// 普通 admin 仅渲染撤销入口，授予入口仅超管可见（服务端同时强制）。
class PermissionsScreen extends StatefulWidget {
  const PermissionsScreen({super.key});

  @override
  State<PermissionsScreen> createState() => _PermissionsScreenState();
}

class _PermissionsScreenState extends State<PermissionsScreen> {
  List<User> _users = [];
  int? _selectedUserId;
  List<PermissionItem> _perms = [];
  bool _loadingUsers = true;
  bool _loadingPerms = false;
  bool _saving = false;
  String? _error;
  final Set<String> _grantedKeys = {};
  final Set<String> _selected = {};

  bool get _isSuper => context.read<AuthState>().user?.isSuperAdmin ?? false;

  @override
  void initState() {
    super.initState();
    _loadUsers();
  }

  Future<void> _loadUsers() async {
    setState(() => _loadingUsers = true);
    try {
      final (list, _) = await AdminApi.users(page: 1, limit: 100);
      if (mounted) setState(() => _users = list);
    } catch (_) {
      if (mounted) setState(() => _error = '加载用户失败');
    } finally {
      if (mounted) setState(() => _loadingUsers = false);
    }
  }

  Future<void> _loadPerms(int userId) async {
    setState(() {
      _selectedUserId = userId;
      _perms = [];
      _grantedKeys.clear();
      _selected.clear();
      _loadingPerms = true;
      _error = null;
    });
    try {
      final perms = await AdminApi.permissions(userId);
      if (!mounted || _selectedUserId != userId) return;
      setState(() {
        _perms = perms;
        _grantedKeys.addAll(perms.where((p) => p.granted).map((p) => p.permKey));
      });
    } catch (_) {
      if (mounted) setState(() => _error = '加载权限失败');
    } finally {
      if (mounted) setState(() => _loadingPerms = false);
    }
  }

  /// 权限类别：按前缀分组（对齐 Web 端分类着色规则）
  static String _categoryOf(String key) {
    if (key.startsWith('articles.') || key.startsWith('novels.')) return '内容访问';
    if (key.startsWith('image-share.')) return '图片分享';
    if (key.startsWith('community.') || key.startsWith('messages.')) return '社区互动';
    if (key.startsWith('users.') || key.startsWith('permissions.')) return '后台管理';
    if (key.startsWith('pages.') || key.startsWith('settings.')) return '系统设置';
    return '基础功能';
  }

  Future<void> _save(Set<String> granted) async {
    setState(() => _saving = true);
    try {
      await AdminApi.updateUserPermissions(_selectedUserId!, granted.toList());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存')));
        _loadPerms(_selectedUserId!);
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _revokeSelected() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('撤销权限'),
        content: Text('确定撤销选中的 ${_selected.length} 项权限吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确认撤销')),
        ],
      ),
    );
    if (ok != true) return;
    final remaining = _grantedKeys.difference(_selected);
    await _save(remaining);
  }

  Future<void> _grantSelected() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('授予权限'),
        content: Text('确定为该用户授予选中的 ${_selected.length} 项权限吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确认授予')),
        ],
      ),
    );
    if (ok != true) return;
    final next = {..._grantedKeys, ..._selected};
    await _save(next);
  }

  @override
  Widget build(BuildContext context) {
    final isSuper = _isSuper;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: _loadingUsers
              ? const LoadingView()
              : DropdownButtonFormField<int?>(
                  initialValue: _selectedUserId,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: '选择用户'),
                  items: [
                    for (final u in _users)
                      DropdownMenuItem(
                        value: u.id,
                        child: Text(
                          '${u.displayName} @${u.username}',
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: (v) {
                    if (v != null) _loadPerms(v);
                  },
                ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text(_error!, style: const TextStyle(color: Colors.red)),
          ),
        Expanded(
          child: _selectedUserId == null
              ? const EmptyView(message: '请先选择用户')
              : _loadingPerms
                  ? const LoadingView()
                  : _perms.isEmpty
                      ? const EmptyView(message: '该用户没有可管理的权限项')
                      : _buildPermissionBody(isSuper),
        ),
      ],
    );
  }

  Widget _buildPermissionBody(bool isSuper) {
    // 按类别分组
    final grouped = <String, List<PermissionItem>>{};
    for (final p in _perms) {
      grouped.putIfAbsent(_categoryOf(p.permKey), () => []).add(p);
    }
    final categories = grouped.keys.toList()..sort();

    final hasSelected = _selected.isNotEmpty;
    final hasGrantable = _perms.any((p) => !p.granted);

    return Column(
      children: [
        if (_saving) const LinearProgressIndicator(minHeight: 2),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.symmetric(vertical: 4),
            children: [
              for (final cat in categories) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
                  child: Text(cat,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFF2563EB))),
                ),
                for (final p in grouped[cat]!) _permTile(p, isSuper),
              ],
            ],
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '${_grantedKeys.length} 项已拥有 · 已选 $_selected.length 项',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                  ),
                ),
                if (hasSelected)
                  FilledButton.tonalIcon(
                    onPressed: _revokeSelected,
                    icon: const Icon(Icons.undo, size: 18),
                    label: const Text('撤销选中'),
                  ),
                if (isSuper && hasSelected && hasGrantable) ...[
                  const SizedBox(width: 8),
                  FilledButton.icon(
                    onPressed: _grantSelected,
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('授予选中'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _permTile(PermissionItem p, bool isSuper) {
    final granted = _grantedKeys.contains(p.permKey);
    final checked = _selected.contains(p.permKey);
    // 普通 admin 仅可勾选已拥有权限（撤销）；超管可勾选任意（授予/撤销）
    final selectable = isSuper || granted;

    return CheckboxListTile(
      dense: true,
      value: checked,
      enabled: selectable && !_saving,
      title: Text(p.permName.isEmpty ? p.permKey : '${p.permName} (${p.permKey})',
          style: const TextStyle(fontSize: 14)),
      subtitle: p.description.isNotEmpty
          ? Text(p.description, style: const TextStyle(fontSize: 12))
          : null,
      secondary: Icon(
        granted ? Icons.check_circle : Icons.radio_button_unchecked,
        color: granted ? Colors.green : Colors.grey,
        size: 20,
      ),
      onChanged: selectable
          ? (v) => setState(() {
                if (v == true) {
                  _selected.add(p.permKey);
                } else {
                  _selected.remove(p.permKey);
                }
              })
          : null,
    );
  }
}
