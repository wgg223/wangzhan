import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../models/admin_models.dart';
import '../../widgets/common.dart';

/// 权限管理：选择一个用户，勾选其权限
class PermissionsScreen extends StatefulWidget {
  const PermissionsScreen({super.key});

  @override
  State<PermissionsScreen> createState() => _PermissionsScreenState();
}

class _PermissionsScreenState extends State<PermissionsScreen> {
  int? _selectedUserId;
  List<PermissionItem> _perms = [];
  late Future<(List<dynamic>, int)> _usersFuture;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _usersFuture = AdminApi.users(page: 1, limit: 100);
  }

  Future<void> _loadPerms(int userId) async {
    setState(() {
      _selectedUserId = userId;
      _perms = [];
    });
    try {
      final perms = await AdminApi.permissions(userId);
      if (mounted) setState(() => _perms = perms);
    } catch (_) {
      if (mounted) setState(() => _error = '加载权限失败');
    }
  }

  Future<void> _save() async {
    if (_selectedUserId == null) return;
    setState(() => _saving = true);
    try {
      final keys = _perms.where((p) => p.granted).map((p) => p.permKey).toList();
      await AdminApi.savePermissions(_selectedUserId!, keys);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('权限已保存')));
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: FutureBuilder<(List<dynamic>, int)>(
            future: _usersFuture,
            builder: (context, snapshot) {
              if (snapshot.connectionState != ConnectionState.done) {
                return const Center(child: CircularProgressIndicator(strokeWidth: 2));
              }
              final users = snapshot.data?.$1 ?? [];
              return DropdownButton<int?>(
                value: _selectedUserId,
                hint: const Text('选择用户'),
                isExpanded: true,
                items: [
                  for (final u in users)
                    DropdownMenuItem(value: (u as Map)['id'] is int ? u['id'] : int.parse('${u['id']}'), child: Text('${u['username']} (${u['nickname'] ?? ''})')),
                ],
                onChanged: (v) {
                  if (v != null) _loadPerms(v);
                },
              );
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
              : _perms.isEmpty
                  ? const LoadingView()
                  : ListView.builder(
                      itemCount: _perms.length,
                      itemBuilder: (context, i) {
                        final p = _perms[i];
                        return CheckboxListTile(
                          dense: true,
                          title: Text(p.permName.isEmpty ? p.permKey : '${p.permName} (${p.permKey})', style: const TextStyle(fontSize: 14)),
                          subtitle: p.description.isNotEmpty ? Text(p.description, style: const TextStyle(fontSize: 12)) : null,
                          value: p.granted,
                          onChanged: (v) => setState(() => _perms[i] = PermissionItem(
                                permKey: p.permKey,
                                permName: p.permName,
                                description: p.description,
                                granted: v ?? false,
                              )),
                        );
                      },
                    ),
        ),
        if (_selectedUserId != null)
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _saving ? null : _save,
                  child: _saving ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('保存权限'),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
