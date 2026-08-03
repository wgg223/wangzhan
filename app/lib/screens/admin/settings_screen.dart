import 'package:flutter/material.dart';

import '../../api/admin_api.dart';
import '../../widgets/common.dart';

/// 系统设置（基础设置 key-value 编辑）
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late Future<Map<String, String>> _future;
  Map<String, String>? _values;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, String>> _load() async {
    final values = await AdminApi.settings();
    if (mounted) _values = values;
    return values;
  }

  Future<void> _save() async {
    if (_values == null) return;
    setState(() => _saving = true);
    try {
      await AdminApi.saveSettings(_values!);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('设置已保存')));
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  static const _commonKeys = [
    'site_name', 'site_title', 'site_description', 'site_keywords',
    'site_url', 'site_icp', 'site_copyright', 'site_logo',
    'contact_email', 'maintenance_title', 'maintenance_message',
  ];

  @override
  Widget build(BuildContext context) {
    return FutureView(
      future: _future,
      reload: () => setState(() => _future = _load()),
      builder: (context, values) {
        return Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.all(12),
                children: [
                  for (final key in _commonKeys)
                    if (_values!.containsKey(key))
                      _SettingField(
                        key: ValueKey(key),
                        label: key,
                        controller: _values![key]!,
                        onChanged: (v) => setState(() => _values![key] = v),
                      ),
                  if (!_values!.containsKey('site_name'))
                    const Padding(
                      padding: EdgeInsets.all(20),
                      child: Center(child: Text('暂无常见设置项，服务器端设置请通过网页后台管理', style: TextStyle(color: Colors.grey))),
                    ),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: Text(_error!, style: const TextStyle(color: Colors.red)),
                    ),
                ],
              ),
            ),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _saving ? null : _save,
                    child: _saving ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('保存设置'),
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _SettingField extends StatelessWidget {
  const _SettingField({super.key, required this.label, required this.controller, required this.onChanged});

  final String label;
  final String controller;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        initialValue: controller,
        decoration: InputDecoration(labelText: label, isDense: true),
        onChanged: onChanged,
      ),
    );
  }
}
