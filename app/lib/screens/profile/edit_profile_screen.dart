import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/api_client.dart';
import '../../api/auth_api.dart';
import '../../state/auth_state.dart';

/// 编辑个人资料 + 修改密码
class EditProfileScreen extends StatefulWidget {
  const EditProfileScreen({super.key});

  @override
  State<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends State<EditProfileScreen> {
  late final TextEditingController _nickname;
  late final TextEditingController _bio;
  final _oldPassword = TextEditingController();
  final _newPassword = TextEditingController();
  final _confirmPassword = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final user = context.read<AuthState>().user;
    _nickname = TextEditingController(text: user?.nickname ?? '');
    _bio = TextEditingController(text: user?.bio ?? '');
  }

  Future<void> _saveProfile() async {
    setState(() => _saving = true);
    try {
      await AuthApi.updateProfile(
        nickname: _nickname.text.trim(),
        bio: _bio.text.trim(),
      );
      final me = await AuthApi.me();
      context.read<AuthState>().refreshUser(me);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('资料已更新')));
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = '网络错误');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _changePassword() async {
    if (_newPassword.text.length < 6) {
      setState(() => _error = '新密码至少 6 位');
      return;
    }
    if (_newPassword.text != _confirmPassword.text) {
      setState(() => _error = '两次输入的新密码不一致');
      return;
    }
    setState(() => _saving = true);
    try {
      await AuthApi.changePassword(_oldPassword.text, _newPassword.text);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('密码已修改')));
        _oldPassword.clear();
        _newPassword.clear();
        _confirmPassword.clear();
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('编辑资料')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('基本资料', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
          const SizedBox(height: 12),
          TextField(controller: _nickname, decoration: const InputDecoration(labelText: '昵称')),
          const SizedBox(height: 12),
          TextField(controller: _bio, maxLines: 3, decoration: const InputDecoration(labelText: '个人简介')),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: _saving ? null : _saveProfile,
            child: _saving ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('保存资料'),
          ),
          const Divider(height: 40),
          const Text('修改密码', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
          const SizedBox(height: 12),
          TextField(controller: _oldPassword, obscureText: true, decoration: const InputDecoration(labelText: '当前密码')),
          const SizedBox(height: 12),
          TextField(controller: _newPassword, obscureText: true, decoration: const InputDecoration(labelText: '新密码（至少6位）')),
          const SizedBox(height: 12),
          TextField(controller: _confirmPassword, obscureText: true, decoration: const InputDecoration(labelText: '确认新密码')),
          const SizedBox(height: 16),
          OutlinedButton(
            onPressed: _saving ? null : _changePassword,
            child: const Text('修改密码'),
          ),
        ],
      ),
    );
  }
}
